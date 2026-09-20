/**
 * Recognizing the mirrored-account email collision.
 *
 * `auth.mirror_authenticated_user` (migration 0080) upserts on `user_id`,
 * which does not cover the unique `idx_users_email` index, so a subject
 * arriving with an address another subject owns raises `23505`. The function
 * rewrites that into an actionable message and hint while keeping the
 * SQLSTATE and the constraint name, and those two discriminators are what the
 * OTP, API-key and consent surfaces match here: the collision is permanent,
 * so it must never surface as a retryable server error.
 */

const UNIQUE_VIOLATION_CODE = "23505";
const EMAIL_UNIQUE_INDEX = "idx_users_email";

export type EmailAlreadyRegisteredError = Error & Readonly<{
  /** The actionable hint the account-state helper raised alongside the message. */
  hint: string;
}>;

/**
 * Whether this error is the email collision, carrying the helper's own
 * message and hint. An error missing the hint is not treated as this case:
 * its message is then not the actionable one callers are meant to relay.
 */
export const isEmailAlreadyRegisteredError = (error: unknown): error is EmailAlreadyRegisteredError => {
  if (!(error instanceof Error)) {
    return false;
  }
  const pgError = error as Readonly<{ code?: unknown; constraint?: unknown; hint?: unknown }>;
  return pgError.code === UNIQUE_VIOLATION_CODE
    && pgError.constraint === EMAIL_UNIQUE_INDEX
    && typeof pgError.hint === "string"
    && pgError.hint !== "";
};
