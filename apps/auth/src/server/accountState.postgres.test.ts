/**
 * Postgres-backed pin for the account-state helpers the auth service calls.
 *
 * `auth.sync_authenticated_user` runs on OTP login, on agent API-key creation
 * and on Cognito OAuth consent; `auth.mirror_authenticated_user` runs on
 * proxy_jwt OAuth consent. Migration 0080 made both insert-only for
 * `cognito_status` and `cognito_enabled`, which is what makes disabling a row
 * an actual revocation, while `email_verified` keeps following the
 * authenticated identity. Only a real database proves the shipped functions
 * behave that way as the `auth_service` role.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const authDatabaseUrl = process.env.AUTH_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || authDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and AUTH_DATABASE_URL are required for Postgres-backed account-state tests";
// CI has to prove the writers really are insert-only, so missing wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

type StoredAccountRow = Readonly<{
  email: string;
  email_verified: boolean;
  cognito_status: string;
  cognito_enabled: boolean;
}>;

const readAccountRow = async (pool: pg.Pool, userId: string): Promise<StoredAccountRow> => {
  const result = await pool.query(
    "SELECT email, email_verified, cognito_status, cognito_enabled FROM public.users WHERE user_id = $1",
    [userId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`Expected exactly 1 users row for ${userId}, got ${result.rows.length}`);
  }
  return result.rows[0] as StoredAccountRow;
};

test(
  "the login, key-creation and consent writers provision a first-seen user and never raise account state",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const syncUserId = `account-state-sync-${suffix}`;
    const mirrorUserId = `account-state-mirror-${suffix}`;
    const collidingUserId = `account-state-collision-${suffix}`;
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const authPool = new pg.Pool({ connectionString: authDatabaseUrl });
    const userIds = [syncUserId, mirrorUserId, collidingUserId];

    try {
      // A first sighting is still provisioned as a confirmed, enabled account.
      await authPool.query("SELECT auth.sync_authenticated_user($1, $2)", [
        syncUserId,
        `${syncUserId}@example.invalid`,
      ]);
      assert.deepEqual(
        await readAccountRow(ownerPool, syncUserId),
        {
          email: `${syncUserId}@example.invalid`,
          email_verified: true,
          cognito_status: "CONFIRMED",
          cognito_enabled: true,
        },
        "OTP login and API-key creation must still provision a first-seen user",
      );

      // The administrative writer disables the account. email_verified is set
      // false too: it is no revocation lever, so logging in again must repair
      // it rather than leave the MCP gate refusing this subject forever.
      await ownerPool.query(
        "UPDATE public.users SET cognito_enabled = false, cognito_status = 'DISABLED', email_verified = false WHERE user_id = $1",
        [syncUserId],
      );

      // Another login, key creation or Cognito consent round-trip for the same subject.
      await authPool.query("SELECT auth.sync_authenticated_user($1, $2)", [
        syncUserId,
        `renamed-${syncUserId}@example.invalid`,
      ]);
      assert.deepEqual(
        await readAccountRow(ownerPool, syncUserId),
        {
          email: `renamed-${syncUserId}@example.invalid`,
          email_verified: true,
          cognito_status: "DISABLED",
          cognito_enabled: false,
        },
        "logging in again must refresh the email and email_verified, never the account state",
      );

      // Re-enabling from the same administrative writer still takes effect, and
      // the next login leaves the restored state alone.
      await ownerPool.query(
        "UPDATE public.users SET cognito_enabled = true, cognito_status = 'CONFIRMED', email_verified = true WHERE user_id = $1",
        [syncUserId],
      );
      await authPool.query("SELECT auth.sync_authenticated_user($1, $2)", [
        syncUserId,
        `renamed-${syncUserId}@example.invalid`,
      ]);
      const reEnabled = await readAccountRow(ownerPool, syncUserId);
      assert.equal(reEnabled.cognito_enabled, true);
      assert.equal(reEnabled.cognito_status, "CONFIRMED");

      // The proxy_jwt consent writer behaves the same way.
      await ownerPool.query(
        `INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled)
         VALUES ($1, $2, true, 'PROXY', false)`,
        [mirrorUserId, `${mirrorUserId}@example.invalid`],
      );
      await authPool.query("SELECT auth.mirror_authenticated_user($1, $2, $3)", [
        mirrorUserId,
        `${mirrorUserId}@example.invalid`,
        "PROXY",
      ]);
      const mirrored = await readAccountRow(ownerPool, mirrorUserId);
      assert.equal(mirrored.cognito_enabled, false, "consent must not re-enable a disabled account");

      // A second subject claiming an address the first one owns collides on the
      // unique email index, which ON CONFLICT (user_id) does not cover. The
      // hint is asserted here because isEmailAlreadyRegisteredError requires
      // it: the unit tests fabricate it, so only a real driver proves that
      // USING HINT survives the round trip and the surfaces do not silently
      // fall back to a retryable server error.
      await assert.rejects(
        () => authPool.query("SELECT auth.sync_authenticated_user($1, $2)", [
          collidingUserId,
          `renamed-${syncUserId}@example.invalid`,
        ]),
        (error: unknown): boolean => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "This email is already registered to a different user");
          assert.equal((error as { code?: unknown }).code, "23505");
          assert.equal((error as { constraint?: unknown }).constraint, "idx_users_email");
          assert.match(
            (error as { hint?: unknown }).hint as string,
            /Accounts are never linked automatically/u,
          );
          // The message is relayed to agents and to OAuth clients, so it must
          // not carry the address or either subject; those stay in DETAIL.
          assert.doesNotMatch(error.message, new RegExp(syncUserId, "u"));
          assert.doesNotMatch(error.message, new RegExp(collidingUserId, "u"));
          assert.match((error as { detail?: unknown }).detail as string, new RegExp(collidingUserId, "u"));
          return true;
        },
      );
    } finally {
      try {
        await ownerPool.query("DELETE FROM public.users WHERE user_id = ANY($1)", [userIds]);
      } finally {
        await Promise.all([ownerPool.end(), authPool.end()]);
      }
    }
  },
);
