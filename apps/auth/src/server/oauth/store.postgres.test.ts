import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { QueryFn } from "../db.js";
import {
  exchangeRefreshTokenWithDependencies,
  type OAuthStoreDependencies,
} from "./store.js";
import { hashOpaqueToken, isOAuthProtocolError } from "./core.js";

type OAuthPostgresFixture = Readonly<{
  clientId: string;
  connectionId: string;
  userId: string;
  resource: string;
  usedAuthorizationCodeHash: string;
  expiredUnusedAuthorizationCodeHash: string;
  activeAccessTokenHash: string;
  expiredAccessTokenHash: string;
  ancestorRefreshToken: string;
  ancestorRefreshTokenHash: string;
  replacementRefreshToken: string;
  replacementRefreshTokenHash: string;
  expiredUnusedRefreshTokenHash: string;
}>;

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const authDatabaseUrl = process.env.AUTH_DATABASE_URL ?? "";
const postgresTestSkip: boolean | string = migrationDatabaseUrl === "" || authDatabaseUrl === ""
  ? "MIGRATION_DATABASE_URL and AUTH_DATABASE_URL are required for Postgres-backed OAuth tests"
  : false;

const createFixture = (): OAuthPostgresFixture => {
  const suffix = randomUUID().replaceAll("-", "");
  const ancestorRefreshToken = `ebt_rt_ancestor_${suffix}`;
  const replacementRefreshToken = `ebt_rt_replacement_${suffix}`;
  return {
    clientId: `ebt_cl_postgres_${suffix}`,
    connectionId: randomUUID(),
    userId: `postgres-user-${suffix}`,
    resource: "https://mcp.example.com/mcp",
    usedAuthorizationCodeHash: hashOpaqueToken(`ebt_ac_used_${suffix}`),
    expiredUnusedAuthorizationCodeHash: hashOpaqueToken(`ebt_ac_expired_${suffix}`),
    activeAccessTokenHash: hashOpaqueToken(`ebt_at_active_${suffix}`),
    expiredAccessTokenHash: hashOpaqueToken(`ebt_at_expired_${suffix}`),
    ancestorRefreshToken,
    ancestorRefreshTokenHash: hashOpaqueToken(ancestorRefreshToken),
    replacementRefreshToken,
    replacementRefreshTokenHash: hashOpaqueToken(replacementRefreshToken),
    expiredUnusedRefreshTokenHash: hashOpaqueToken(`ebt_rt_expired_${suffix}`),
  };
};

const insertFixture = async (
  pool: pg.Pool,
  fixture: OAuthPostgresFixture,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO auth.oauth_clients (client_id, client_name, redirect_uris)
       VALUES ($1, $2, $3)`,
      [fixture.clientId, "Postgres OAuth replay test", ["https://client.example/callback"]],
    );
    await client.query(
      `INSERT INTO auth.oauth_connections (connection_id, client_id, user_id, resource)
       VALUES ($1, $2, $3, $4)`,
      [fixture.connectionId, fixture.clientId, fixture.userId, fixture.resource],
    );
    await client.query(
      `INSERT INTO auth.oauth_authorization_codes
         (code_hash, connection_id, redirect_uri, code_challenge, scopes, created_at, expires_at, used_at)
       VALUES
         ($1, $3, $4, $5, $6, now() - INTERVAL '40 days 5 minutes', now() - INTERVAL '40 days', now() - INTERVAL '40 days 4 minutes'),
         ($2, $3, $4, $5, $6, now() - INTERVAL '10 minutes', now() - INTERVAL '5 minutes', NULL)`,
      [
        fixture.usedAuthorizationCodeHash,
        fixture.expiredUnusedAuthorizationCodeHash,
        fixture.connectionId,
        "https://client.example/callback",
        "a".repeat(43),
        ["expenses:read"],
      ],
    );
    await client.query(
      `INSERT INTO auth.oauth_access_tokens
         (token_hash, connection_id, scopes, created_at, expires_at)
       VALUES
         ($1, $3, $4, now(), now() + INTERVAL '1 hour'),
         ($2, $3, $4, now() - INTERVAL '2 hours', now() - INTERVAL '1 hour')`,
      [
        fixture.activeAccessTokenHash,
        fixture.expiredAccessTokenHash,
        fixture.connectionId,
        ["expenses:read"],
      ],
    );
    await client.query(
      `INSERT INTO auth.oauth_refresh_tokens
         (token_hash, connection_id, scopes, created_at, expires_at, used_at)
       VALUES
         ($1, $4, $5, now() - INTERVAL '61 days', now() - INTERVAL '31 days', now() - INTERVAL '60 days'),
         ($2, $4, $5, now(), now() + INTERVAL '30 days', NULL),
         ($3, $4, $5, now() - INTERVAL '31 days', now() - INTERVAL '1 day', NULL)`,
      [
        fixture.ancestorRefreshTokenHash,
        fixture.replacementRefreshTokenHash,
        fixture.expiredUnusedRefreshTokenHash,
        fixture.connectionId,
        ["expenses:read"],
      ],
    );
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const createQueryFn = (pool: pg.Pool): QueryFn =>
  (text: string, params: ReadonlyArray<unknown>) => pool.query(text, Array.from(params));

const createTransactionRunner = (
  pool: pg.Pool,
): OAuthStoreDependencies["withTransaction"] => async <T>(
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transactionQuery: QueryFn = (text: string, params: ReadonlyArray<unknown>) =>
      client.query(text, Array.from(params));
    const result = await callback(transactionQuery);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const readBooleanColumn = (
  row: unknown,
  key: string,
  operation: string,
): boolean => {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${operation}: database returned an invalid row`);
  }
  const value = (row as Readonly<Record<string, unknown>>)[key];
  if (typeof value !== "boolean") {
    throw new Error(`${operation}: database column ${key} must be a boolean`);
  }
  return value;
};

const rejectsInvalidGrant = async (operation: Promise<unknown>): Promise<void> => {
  await assert.rejects(
    operation,
    (error: unknown): boolean => isOAuthProtocolError(error) && error.oauthCode === "invalid_grant",
  );
};

test(
  "real cleanup retains an active ancestor tombstone and production replay revokes its replacement family",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    const fixture = createFixture();
    const migrationPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const authPool = new pg.Pool({ connectionString: authDatabaseUrl });

    try {
      await insertFixture(migrationPool, fixture);

      const authQuery = createQueryFn(authPool);
      const roleResult = await authQuery("SELECT current_user = 'auth_service' AS is_auth_service", []);
      assert.equal(readBooleanColumn(roleResult.rows[0], "is_auth_service", "OAuth Postgres role check"), true);

      const dependencies: OAuthStoreDependencies = {
        query: authQuery,
        withTransaction: createTransactionRunner(authPool),
        createOpaqueToken: (prefix) => {
          throw new Error(`OAuth Postgres replay test unexpectedly created a ${prefix} token`);
        },
        getCognitoOAuthOwnerStatus: async (userId) => {
          throw new Error(`OAuth Postgres replay test unexpectedly checked Cognito owner ${userId}`);
        },
      };

      const activeAccessBeforeReplay = await migrationPool.query(
        `SELECT EXISTS (
           SELECT 1
           FROM auth.validate_oauth_access_token($1)
         ) AS usable`,
        [fixture.activeAccessTokenHash],
      );
      assert.equal(
        readBooleanColumn(activeAccessBeforeReplay.rows[0], "usable", "OAuth active-family setup check"),
        true,
      );

      await rejectsInvalidGrant(exchangeRefreshTokenWithDependencies(
        fixture.ancestorRefreshToken,
        fixture.clientId,
        fixture.resource,
        null,
        dependencies,
      ));

      const afterAncestorReplay = await migrationPool.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM auth.oauth_connections
             WHERE connection_id = $1 AND revoked_at IS NOT NULL
           ) AS connection_revoked,
           EXISTS (
             SELECT 1 FROM auth.oauth_authorization_codes
             WHERE code_hash = $2
           ) AS used_code_retained,
           EXISTS (
             SELECT 1 FROM auth.oauth_refresh_tokens
             WHERE token_hash = $3
           ) AS ancestor_retained,
           NOT EXISTS (
             SELECT 1 FROM auth.oauth_authorization_codes
             WHERE code_hash = $4
           ) AS expired_unused_code_deleted,
           NOT EXISTS (
             SELECT 1 FROM auth.oauth_refresh_tokens
             WHERE token_hash = $5
           ) AS expired_unused_refresh_deleted,
           NOT EXISTS (
             SELECT 1 FROM auth.oauth_access_tokens
             WHERE token_hash = $6
           ) AS expired_access_deleted,
           NOT EXISTS (
             SELECT 1 FROM auth.validate_oauth_access_token($7)
           ) AS replacement_access_revoked`,
        [
          fixture.connectionId,
          fixture.usedAuthorizationCodeHash,
          fixture.ancestorRefreshTokenHash,
          fixture.expiredUnusedAuthorizationCodeHash,
          fixture.expiredUnusedRefreshTokenHash,
          fixture.expiredAccessTokenHash,
          fixture.activeAccessTokenHash,
        ],
      );
      const afterAncestorReplayRow = afterAncestorReplay.rows[0];
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "connection_revoked", "OAuth ancestor replay check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "used_code_retained", "OAuth used-code retention check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "ancestor_retained", "OAuth ancestor retention check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "expired_unused_code_deleted", "OAuth expired-code cleanup check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "expired_unused_refresh_deleted", "OAuth expired-refresh cleanup check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "expired_access_deleted", "OAuth expired-access cleanup check"), true);
      assert.equal(readBooleanColumn(afterAncestorReplayRow, "replacement_access_revoked", "OAuth family revocation check"), true);

      await rejectsInvalidGrant(exchangeRefreshTokenWithDependencies(
        fixture.replacementRefreshToken,
        fixture.clientId,
        fixture.resource,
        null,
        dependencies,
      ));

      const afterRevokedCleanup = await migrationPool.query(
        `SELECT
           NOT EXISTS (
             SELECT 1 FROM auth.oauth_authorization_codes
             WHERE code_hash = $1
           ) AS used_code_deleted,
           NOT EXISTS (
             SELECT 1 FROM auth.oauth_refresh_tokens
             WHERE token_hash = $2
           ) AS ancestor_deleted,
           EXISTS (
             SELECT 1 FROM auth.oauth_refresh_tokens
             WHERE token_hash = $3
           ) AS replacement_retained`,
        [
          fixture.usedAuthorizationCodeHash,
          fixture.ancestorRefreshTokenHash,
          fixture.replacementRefreshTokenHash,
        ],
      );
      const afterRevokedCleanupRow = afterRevokedCleanup.rows[0];
      assert.equal(readBooleanColumn(afterRevokedCleanupRow, "used_code_deleted", "OAuth revoked-code cleanup check"), true);
      assert.equal(readBooleanColumn(afterRevokedCleanupRow, "ancestor_deleted", "OAuth revoked-refresh cleanup check"), true);
      assert.equal(readBooleanColumn(afterRevokedCleanupRow, "replacement_retained", "OAuth active-replacement cleanup check"), true);
    } finally {
      try {
        await migrationPool.query("DELETE FROM auth.oauth_clients WHERE client_id = $1", [fixture.clientId]);
      } finally {
        await Promise.all([authPool.end(), migrationPool.end()]);
      }
    }
  },
);

test(
  "real revoked-family cleanup makes bounded round-robin progress across multiple calls",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    const suffix = randomUUID().replaceAll("-", "");
    const clientId = `ebt_cl_cleanup_${suffix}`;
    const largeConnectionId = randomUUID();
    const emptyConnectionIds: ReadonlyArray<string> = [randomUUID(), randomUUID()];
    const laterConnectionId = randomUUID();
    const connectionIds: ReadonlyArray<string> = [
      largeConnectionId,
      ...emptyConnectionIds,
      laterConnectionId,
    ];
    const largeCodeHashes: ReadonlyArray<string> = Array.from(
      { length: 101 },
      (_, index) => hashOpaqueToken(`ebt_ac_cleanup_large_${suffix}_${index}`),
    );
    const laterCodeHash = hashOpaqueToken(`ebt_ac_cleanup_later_${suffix}`);
    const laterRefreshHash = hashOpaqueToken(`ebt_rt_cleanup_later_${suffix}`);
    const migrationPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const authPool = new pg.Pool({ connectionString: authDatabaseUrl });

    try {
      const client = await migrationPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO auth.oauth_clients (client_id, client_name, redirect_uris)
           VALUES ($1, $2, $3)`,
          [clientId, "Postgres OAuth cleanup queue test", ["https://client.example/callback"]],
        );
        for (const [index, connectionId] of connectionIds.entries()) {
          await client.query(
            `INSERT INTO auth.oauth_connections (connection_id, client_id, user_id, resource)
             VALUES ($1, $2, $3, $4)`,
            [connectionId, clientId, `cleanup-user-${suffix}-${index}`, "https://mcp.example.com/mcp"],
          );
        }
        await client.query(
          `INSERT INTO auth.oauth_authorization_codes
             (code_hash, connection_id, redirect_uri, code_challenge, scopes, created_at, expires_at, used_at)
           SELECT generated.code_hash, $2, $3, $4, $5,
                  now() - INTERVAL '10 minutes',
                  now() - INTERVAL '5 minutes',
                  now() - INTERVAL '9 minutes'
           FROM unnest($1::TEXT[]) AS generated(code_hash)`,
          [
            largeCodeHashes,
            largeConnectionId,
            "https://client.example/callback",
            "a".repeat(43),
            ["expenses:read"],
          ],
        );
        await client.query(
          `INSERT INTO auth.oauth_authorization_codes
             (code_hash, connection_id, redirect_uri, code_challenge, scopes, created_at, expires_at, used_at)
           VALUES ($1, $2, $3, $4, $5,
                   now() - INTERVAL '10 minutes',
                   now() - INTERVAL '5 minutes',
                   now() - INTERVAL '9 minutes')`,
          [
            laterCodeHash,
            laterConnectionId,
            "https://client.example/callback",
            "a".repeat(43),
            ["expenses:read"],
          ],
        );
        await client.query(
          `INSERT INTO auth.oauth_refresh_tokens
             (token_hash, connection_id, scopes, created_at, expires_at, used_at)
           VALUES ($1, $2, $3,
                   now() - INTERVAL '31 days',
                   now() - INTERVAL '1 day',
                   now() - INTERVAL '30 days')`,
          [laterRefreshHash, laterConnectionId, ["expenses:read"]],
        );
        for (const connectionId of connectionIds) {
          await client.query(
            `UPDATE auth.oauth_connections
             SET revoked_at = now()
             WHERE connection_id = $1`,
            [connectionId],
          );
        }
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const authQuery = createQueryFn(authPool);
      const privilegeResult = await authQuery(
        `SELECT NOT has_table_privilege(
           current_user,
           'auth.oauth_revoked_connection_cleanup_queue',
           'DELETE'
         ) AS delete_denied`,
        [],
      );
      assert.equal(
        readBooleanColumn(privilegeResult.rows[0], "delete_denied", "OAuth cleanup queue privilege check"),
        true,
      );

      await authQuery("SELECT auth.cleanup_expired_oauth_transient_state()", []);

      const afterLargeBatch = await migrationPool.query(
        `SELECT
           (SELECT count(*) FROM auth.oauth_authorization_codes
            WHERE connection_id = $1 AND used_at IS NOT NULL) = 1 AS large_family_has_one_code,
           EXISTS (SELECT 1 FROM auth.oauth_authorization_codes WHERE code_hash = $2) AS later_code_retained,
           EXISTS (SELECT 1 FROM auth.oauth_refresh_tokens WHERE token_hash = $3) AS later_refresh_retained,
           (SELECT count(*) FROM auth.oauth_revoked_connection_cleanup_queue
            WHERE connection_id = ANY($4::TEXT[])) = 4 AS all_families_queued`,
        [largeConnectionId, laterCodeHash, laterRefreshHash, connectionIds],
      );
      const afterLargeBatchRow = afterLargeBatch.rows[0];
      assert.equal(readBooleanColumn(afterLargeBatchRow, "large_family_has_one_code", "OAuth large-family batch check"), true);
      assert.equal(readBooleanColumn(afterLargeBatchRow, "later_code_retained", "OAuth later code setup check"), true);
      assert.equal(readBooleanColumn(afterLargeBatchRow, "later_refresh_retained", "OAuth later refresh setup check"), true);
      assert.equal(readBooleanColumn(afterLargeBatchRow, "all_families_queued", "OAuth cleanup queue setup check"), true);

      await authQuery("SELECT auth.cleanup_expired_oauth_transient_state()", []);
      await authQuery("SELECT auth.cleanup_expired_oauth_transient_state()", []);
      await authQuery("SELECT auth.cleanup_expired_oauth_transient_state()", []);

      const afterLaterFamily = await migrationPool.query(
        `SELECT
           NOT EXISTS (SELECT 1 FROM auth.oauth_authorization_codes WHERE code_hash = $1) AS later_code_deleted,
           NOT EXISTS (SELECT 1 FROM auth.oauth_refresh_tokens WHERE token_hash = $2) AS later_refresh_deleted,
           EXISTS (SELECT 1 FROM auth.oauth_authorization_codes
                   WHERE connection_id = $3 AND used_at IS NOT NULL) AS large_family_still_queued,
           NOT EXISTS (SELECT 1 FROM auth.oauth_revoked_connection_cleanup_queue
                       WHERE connection_id = ANY($4::TEXT[])) AS empty_and_later_families_dequeued`,
        [laterCodeHash, laterRefreshHash, largeConnectionId, [...emptyConnectionIds, laterConnectionId]],
      );
      const afterLaterFamilyRow = afterLaterFamily.rows[0];
      assert.equal(readBooleanColumn(afterLaterFamilyRow, "later_code_deleted", "OAuth later code cleanup check"), true);
      assert.equal(readBooleanColumn(afterLaterFamilyRow, "later_refresh_deleted", "OAuth later refresh cleanup check"), true);
      assert.equal(readBooleanColumn(afterLaterFamilyRow, "large_family_still_queued", "OAuth round-robin fairness check"), true);
      assert.equal(
        readBooleanColumn(afterLaterFamilyRow, "empty_and_later_families_dequeued", "OAuth empty-family progress check"),
        true,
      );

      await authQuery("SELECT auth.cleanup_expired_oauth_transient_state()", []);

      const afterDrain = await migrationPool.query(
        `SELECT
           NOT EXISTS (SELECT 1 FROM auth.oauth_authorization_codes
                       WHERE connection_id = $1 AND used_at IS NOT NULL) AS large_family_drained,
           NOT EXISTS (SELECT 1 FROM auth.oauth_revoked_connection_cleanup_queue
                       WHERE connection_id = ANY($2::TEXT[])) AS queue_drained`,
        [largeConnectionId, connectionIds],
      );
      assert.equal(readBooleanColumn(afterDrain.rows[0], "large_family_drained", "OAuth large-family drain check"), true);
      assert.equal(readBooleanColumn(afterDrain.rows[0], "queue_drained", "OAuth cleanup queue drain check"), true);
    } finally {
      try {
        await migrationPool.query("DELETE FROM auth.oauth_clients WHERE client_id = $1", [clientId]);
      } finally {
        await Promise.all([authPool.end(), migrationPool.end()]);
      }
    }
  },
);
