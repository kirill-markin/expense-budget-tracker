/**
 * Postgres-backed pin for the production account-state gate.
 *
 * The unit tests inject a stub loader, so nothing there proves the default
 * wiring works: that withUserOnlyContext really sets app.user_id for the
 * queries it runs, so the user_self_access policy on `users`
 * (db/migrations/0013_users.sql) returns the caller's own row instead of zero
 * rows, which apiKeyAuth maps to `account_disabled`. A silent break there would
 * refuse every API-key caller at once, so it is exercised against a real
 * database as the `app` role RLS applies to.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed API-key account-state test";
// CI has to prove the gate reads real rows, so missing database wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

// The web pool is built from DATABASE_URL the first time the pool module is
// imported, so it is pointed at the app role before apiKeyAuth is loaded inside
// the test body. That import has to stay dynamic for this to run first.
process.env.DATABASE_URL = appDatabaseUrl;

test(
  "loadStoredAccountState reads the caller's own users row and follows it into the disabled state",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const userId = `api-key-auth-user-${randomUUID().replaceAll("-", "")}`;
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const { loadStoredAccountState } = await import("@/server/agent/apiKeyAuth");
    const { getPool } = await import("@/server/db");

    try {
      await ownerPool.query(
        `INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled)
         VALUES ($1, $2, true, 'CONFIRMED', true)`,
        [userId, `${userId}@example.invalid`],
      );

      assert.deepEqual(
        await loadStoredAccountState(userId),
        { cognitoStatus: "CONFIRMED", cognitoEnabled: true, emailVerified: true },
        "an enabled account must be readable through its own RLS context",
      );

      // email_verified is cleared alongside the account state: an ApiKey
      // proves nothing about the address, so the stored value is what the
      // request must carry into the MCP access-token gate.
      await ownerPool.query(
        "UPDATE public.users SET cognito_enabled = false, email_verified = false WHERE user_id = $1",
        [userId],
      );

      assert.deepEqual(
        await loadStoredAccountState(userId),
        { cognitoStatus: "CONFIRMED", cognitoEnabled: false, emailVerified: false },
        "disabling the row must be visible on the very next read",
      );

      // A user with no row reads as null, which the gate refuses the same way.
      assert.equal(await loadStoredAccountState(`${userId}-absent`), null);
    } finally {
      try {
        await ownerPool.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
      } finally {
        await Promise.all([ownerPool.end(), getPool().end()]);
      }
    }
  },
);
