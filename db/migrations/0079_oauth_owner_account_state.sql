-- Provider-neutral OAuth owner state for AUTH_MODE=proxy_jwt.
--
-- In proxy_jwt the auth service has no Cognito user pool to ask, so the
-- identity mirror in public.users becomes the authority for whether an account
-- may hold OAuth credentials. Two narrow SECURITY DEFINER helpers serve that,
-- granted only to auth_service:
--
--   * auth.get_oauth_owner_account_state reads the account state the OAuth
--     issuance, exchange and refresh paths gate on.
--   * auth.mirror_authenticated_user records the authenticated identity
--     without ever raising the account state of an existing row, so a consent
--     round-trip can no longer re-enable a disabled account or overwrite the
--     status the web app wrote.
--
-- auth.sync_authenticated_user is left exactly as it is: Cognito callers keep
-- their current behavior, because there the user pool, not this table, decides.

CREATE FUNCTION auth.get_oauth_owner_account_state(p_user_id TEXT)
RETURNS TABLE(account_status TEXT, account_enabled BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'auth.get_oauth_owner_account_state: p_user_id must be non-empty';
  END IF;

  RETURN QUERY
    SELECT account.cognito_status, account.cognito_enabled
    FROM public.users AS account
    WHERE account.user_id = p_user_id;
END;
$$;

CREATE FUNCTION auth.mirror_authenticated_user(
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

  -- p_initial_status and email_verified apply only to a first sighting of this
  -- subject. An existing row keeps its cognito_status, cognito_enabled and
  -- email_verified, so account state changes only where it is administered.
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
        last_seen_at = now(),
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION auth.get_oauth_owner_account_state(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.get_oauth_owner_account_state(TEXT) TO auth_service;

REVOKE ALL ON FUNCTION auth.mirror_authenticated_user(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.mirror_authenticated_user(TEXT, TEXT, TEXT) TO auth_service;
