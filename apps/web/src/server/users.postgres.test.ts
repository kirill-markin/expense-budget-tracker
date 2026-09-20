/**
 * Postgres-backed pin for the identity mirror's insert-only account state.
 *
 * The unit tests read the statement text; only a real database proves what the
 * `app` role actually leaves in `public.users` after a request. A browser page
 * load and an ApiKey request share this upsert, so this covers both: whatever
 * account state the request carries, a disabled row stays disabled, while a
 * first-seen subject is still provisioned and a stale `email_verified` is
 * repaired from the verified identity token.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { upsertUserIdentity, type UserIdentity } from "@/server/users";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed identity mirror test";
// CI has to prove the writer really is insert-only, so missing wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

type StoredAccountRow = Readonly<{
  email: string;
  email_verified: boolean;
  cognito_status: string;
  cognito_enabled: boolean;
}>;

/** Run the upsert exactly as a request does: inside a transaction, as the app role. */
const runRequestUpsert = async (pool: pg.Pool, identity: UserIdentity): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await upsertUserIdentity(client, identity);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

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
  "an ordinary request provisions a first-seen user and never raises a disabled account",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const userId = `mirror-user-${randomUUID().replaceAll("-", "")}`;
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const appPool = new pg.Pool({ connectionString: appDatabaseUrl });
    const identity: UserIdentity = {
      userId,
      email: `${userId}@example.invalid`,
      emailVerified: true,
      cognitoStatus: "CONFIRMED",
      cognitoEnabled: true,
    };

    try {
      await runRequestUpsert(appPool, identity);
      assert.deepEqual(
        await readAccountRow(ownerPool, userId),
        {
          email: identity.email,
          email_verified: true,
          cognito_status: "CONFIRMED",
          cognito_enabled: true,
        },
        "a first-seen subject must still be provisioned from the identity it presents",
      );

      // The administrative writer is the only one that moves account state.
      // email_verified is set false too, standing in for a row first seen
      // before the provider marked the address verified: the MCP gate reads
      // the stored value, so an ordinary request has to be able to repair it.
      await ownerPool.query(
        "UPDATE public.users SET cognito_enabled = false, cognito_status = 'DISABLED', email_verified = false WHERE user_id = $1",
        [userId],
      );

      await runRequestUpsert(appPool, { ...identity, email: `renamed-${identity.email}` });
      assert.deepEqual(
        await readAccountRow(ownerPool, userId),
        {
          email: `renamed-${identity.email}`,
          email_verified: true,
          cognito_status: "DISABLED",
          cognito_enabled: false,
        },
        "a request carrying an enabled identity must not re-enable the stored account, but a verified token must repair email_verified",
      );

      // The provider withdrawing the claim reaches the row as well.
      await runRequestUpsert(appPool, { ...identity, email: `renamed-${identity.email}`, emailVerified: false });
      assert.equal(
        (await readAccountRow(ownerPool, userId)).email_verified,
        false,
        "email_verified must follow the identity token in both directions",
      );

      // Re-enabling from the same administrative writer still takes effect.
      await ownerPool.query(
        "UPDATE public.users SET cognito_enabled = true, cognito_status = 'CONFIRMED' WHERE user_id = $1",
        [userId],
      );
      const reEnabled = await readAccountRow(ownerPool, userId);
      assert.equal(reEnabled.cognito_enabled, true);
      assert.equal(reEnabled.cognito_status, "CONFIRMED");
    } finally {
      try {
        await ownerPool.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
      } finally {
        await Promise.all([ownerPool.end(), appPool.end()]);
      }
    }
  },
);
