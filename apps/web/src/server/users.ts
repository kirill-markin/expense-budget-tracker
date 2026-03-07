/**
 * Helpers for mirroring authenticated Cognito users into the local `users`
 * table and provisioning strictly user-scoped settings rows.
 *
 * This module does not decide workspace membership. Authorization continues to
 * live in workspace_members and workspace-scoped RLS policies.
 */
import { type PoolClient } from "pg";

import { type SupportedLocale } from "@/lib/locale";

export const LOCAL_USER_EMAIL = "local@example.invalid";
export const LOCAL_USER_STATUS = "LOCAL";
export const COGNITO_AUTHENTICATED_STATUS = "CONFIRMED";

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
 * `last_seen_at` and `updated_at` move forward on every authenticated request
 * so the row reflects recent activity without changing `first_seen_at`.
 */
export const upsertUserIdentity = async (
  client: PoolClient,
  identity: UserIdentity,
): Promise<void> => {
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
