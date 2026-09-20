-- Account state in public.users is written only where it is administered.
--
-- users.cognito_enabled is the per-request revocation lever every agent
-- surface reads. It is only a lever if no ordinary request can raise it back,
-- so auth.sync_authenticated_user stops hardcoding cognito_status and
-- cognito_enabled on conflict: OTP login, agent API-key creation and Cognito
-- OAuth consent now record the identity without touching the stored account
-- state. This supersedes the note in 0079_oauth_owner_account_state.sql that
-- left this function as it was.
--
-- email_verified is deliberately not frozen. It is no revocation lever but
-- the provider's current claim about the address, and the MCP access-token
-- gate reads the stored value, so a subject first seen before the address was
-- marked verified would otherwise be stranded with no in-product repair.
-- Both helpers run only after that subject authenticated, so they keep
-- refreshing it on conflict.
--
-- The two helpers converge instead of staying a near-duplicate pair:
-- auth.mirror_authenticated_user (0079) keeps the single INSERT, and
-- auth.sync_authenticated_user delegates to it with the Cognito confirmed
-- status. The literal 'CONFIRMED' mirrors COGNITO_AUTHENTICATED_STATUS in
-- packages/agent-shared/src/accountStatus.ts, the single declaration of this
-- vocabulary.
--
-- Both helpers also stop surfacing the permanent idx_users_email collision as
-- an opaque server error. ON CONFLICT (user_id) does not cover the unique
-- email index, so a subject arriving with an address another subject owns
-- raises 23505; the rewritten error keeps that SQLSTATE and constraint name
-- while saying what the caller must do.
-- apps/auth/src/server/accountState.ts matches the SQLSTATE, the constraint
-- name and the hint, so OTP login and API-key creation answer a non-retryable
-- 409 and OAuth consent answers access_denied rather than a generic server
-- error.
--
-- Only a collision with a committed row owned by another subject is rewritten.
-- The same index also catches concurrent first inserts, which surface there
-- before the ON CONFLICT (user_id) branch can resolve the duplicate; that race
-- is transient, and apps/web/src/server/db/provisioning.ts recovers from it by
-- re-reading the committed state. So the owner is resolved first and the
-- original error is re-raised unless another subject really owns the address,
-- and a racing caller is still told to retry rather than to sign in as
-- someone else.
--
-- The rewritten message is static. It is relayed verbatim into an agent error
-- envelope and into the OAuth error_description a client reads off a redirect
-- URI, so the address and the subject stay in DETAIL, which never leaves the
-- database log. The owning subject is never looked up into the message either:
-- these helpers are SECURITY DEFINER and read past the RLS policy on users.
--
-- CREATE OR REPLACE keeps the existing privileges; they are restated so the
-- intended grant is readable in one place.

CREATE OR REPLACE FUNCTION auth.mirror_authenticated_user(
  p_user_id TEXT,
  p_email TEXT,
  p_initial_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
DECLARE
  v_constraint TEXT;
  v_owner TEXT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'auth.mirror_authenticated_user: p_user_id must be non-empty';
  END IF;

  IF p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'auth.mirror_authenticated_user: p_email must be non-empty';
  END IF;

  IF p_initial_status IS NULL OR p_initial_status = '' THEN
    RAISE EXCEPTION 'auth.mirror_authenticated_user: p_initial_status must be non-empty';
  END IF;

  -- p_initial_status applies only to a first sighting of this subject. An
  -- existing row keeps its cognito_status and cognito_enabled, so account
  -- state changes only where it is administered. email_verified is refreshed
  -- instead: this function runs only after the subject authenticated, and the
  -- MCP gate reads the stored value.
  BEGIN
    INSERT INTO public.users (
      user_id,
      email,
      email_verified,
      cognito_status,
      cognito_enabled
    ) VALUES (
      p_user_id,
      p_email,
      true,
      p_initial_status,
      true
    )
    ON CONFLICT (user_id) DO UPDATE
      SET email = EXCLUDED.email,
          email_verified = EXCLUDED.email_verified,
          last_seen_at = now(),
          updated_at = now();
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'idx_users_email' THEN
      RAISE;
    END IF;
    -- Who owns the address decides whether this is permanent. Only user_id is
    -- read, and it stays out of the raised error: this runs with the definer's
    -- rights over the whole table. A conflicting tuple that is still
    -- uncommitted, or already gone, reads as no owner at all, and a row this
    -- same subject owns is no conflict either: both are transient and keep
    -- the original retryable error.
    SELECT user_id INTO v_owner FROM public.users WHERE email = p_email;
    IF v_owner IS NULL OR v_owner = p_user_id THEN
      RAISE;
    END IF;
    RAISE EXCEPTION 'This email is already registered to a different user'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'idx_users_email',
            DETAIL = format('Subject %s claimed email %s', p_user_id, p_email),
            HINT = 'Accounts are never linked automatically: sign in with the subject that owns this email, or change the email on one of the two identities.';
  END;
END;
$$;

CREATE OR REPLACE FUNCTION auth.sync_authenticated_user(p_user_id TEXT, p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'auth.sync_authenticated_user: p_user_id must be non-empty';
  END IF;

  IF p_email IS NULL OR p_email = '' THEN
    RAISE EXCEPTION 'auth.sync_authenticated_user: p_email must be non-empty';
  END IF;

  PERFORM auth.mirror_authenticated_user(p_user_id, p_email, 'CONFIRMED');
END;
$$;

REVOKE ALL ON FUNCTION auth.mirror_authenticated_user(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.mirror_authenticated_user(TEXT, TEXT, TEXT) TO auth_service;

REVOKE ALL ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.sync_authenticated_user(TEXT, TEXT) TO auth_service;
