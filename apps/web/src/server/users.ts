/**
 * Helpers for mirroring authenticated Cognito users into the local `users`
 * table and provisioning strictly user-scoped settings rows.
 *
 * This module does not decide workspace membership. Authorization continues to
 * live in workspace_members and workspace-scoped RLS policies.
 */
import { type PoolClient } from "pg";

import { type SupportedLocale } from "@/lib/locale";

/**
 * The mirrored account-state vocabulary is shared with the SQL API and the
 * auth service, so one source decides which statuses mean an active account.
 */
export {
  COGNITO_AUTHENTICATED_STATUS,
  PROXY_AUTHENTICATED_STATUS,
} from "@expense-budget-tracker/agent-shared/account-status";

export const LOCAL_USER_EMAIL = "local@example.invalid";
export const LOCAL_USER_STATUS = "LOCAL";

const UNIQUE_VIOLATION_CODE = "23505";
const EMAIL_UNIQUE_INDEX = "idx_users_email";

const isEmailAlreadyTakenError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const pgError = error as Readonly<{ code?: unknown; constraint?: unknown }>;
  return pgError.code === UNIQUE_VIOLATION_CODE && pgError.constraint === EMAIL_UNIQUE_INDEX;
};

export type UserIdentity = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
  cognitoStatus: string;
  cognitoEnabled: boolean;
}>;

/**
 * Upsert the local identity mirror from trusted auth claims.
 *
 * Callers must already be in a transaction. The transaction-scoped advisory
 * lock serializes identity writes for this user across runtime instances.
 *
 * `last_seen_at` and `updated_at` move forward on every authenticated request
 * so the row reflects recent activity without changing `first_seen_at`.
 *
 * Emails are unique per user: two subjects claiming the same address is a
 * conflict the app refuses rather than silently linking the accounts.
 *
 * `cognito_status` and `cognito_enabled` are written from the identity as
 * given, so every caller must pass account state it actually knows. The ApiKey
 * path reads both from the stored row instead of asserting them, which is what
 * keeps a disabled account disabled.
 */
export const upsertUserIdentity = async (
  client: PoolClient,
  identity: UserIdentity,
): Promise<void> => {
  await client.query(
    "SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64))::bigint)",
    [identity.userId],
  );
  try {
    await client.query(
      `INSERT INTO users (
         user_id,
         email,
         email_verified,
         cognito_status,
         cognito_enabled
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET email = EXCLUDED.email,
             email_verified = EXCLUDED.email_verified,
             cognito_status = EXCLUDED.cognito_status,
             cognito_enabled = EXCLUDED.cognito_enabled,
             last_seen_at = now(),
             updated_at = now()`,
      [
        identity.userId,
        identity.email,
        identity.emailVerified,
        identity.cognitoStatus,
        identity.cognitoEnabled,
      ],
    );
  } catch (error) {
    if (isEmailAlreadyTakenError(error)) {
      // The PostgreSQL discriminators must survive the clearer message: callers
      // such as the provisioning race recovery match on `code` and `constraint`
      // to tell a concurrent first request apart from a real collision.
      throw Object.assign(
        new Error(
          `Email ${identity.email} is already registered to a different user than subject ${identity.userId}. Accounts are never linked automatically: sign in with the subject that owns this email, or change the email on one of the two identities.`,
          { cause: error },
        ),
        { code: UNIQUE_VIOLATION_CODE, constraint: EMAIL_UNIQUE_INDEX },
      );
    }
    throw error;
  }
};

/**
 * Ensure a per-user settings row exists.
 *
 * Locale is only used on first insert; subsequent updates go through the
 * dedicated user settings API.
 */
export const ensureUserSettingsRow = async (
  client: PoolClient,
  userId: string,
  locale: SupportedLocale,
): Promise<void> => {
  await client.query(
    "INSERT INTO user_settings (user_id, locale) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING",
    [userId, locale],
  );
};
