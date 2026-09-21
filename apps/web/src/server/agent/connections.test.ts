import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResult } from "pg";

import {
  createApiKeyConnectionWithDependencies,
  listAgentConnectionsWithDependencies,
  revokeAgentConnectionByType,
  MAX_ACTIVE_API_KEY_CONNECTIONS,
  type AgentConnectionCreationDependencies,
  type AgentConnectionRevocationDependencies,
} from "@/server/agent/connections";
import type { QueryFn } from "@/server/db/contextRunner";

const createQueryResult = (
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

type RecordedStatement = Readonly<{ sql: string; params: ReadonlyArray<unknown> }>;

/**
 * Runs the whole creation callback on one recorded queryFn, the way
 * withUserContext runs it on one transaction, so a test can see the exact
 * statement order the cap depends on.
 */
const createUserContextDependencies = (
  recorded: Array<RecordedStatement>,
  respond: (sql: string) => QueryResult,
): AgentConnectionCreationDependencies => ({
  withUserContext: async <T>(
    _userId: string,
    _workspaceId: string,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> =>
    callback(async (sql, params): Promise<QueryResult> => {
      recorded.push({ sql, params });
      return respond(sql);
    }),
});

const isLockStatement = (sql: string): boolean => sql.includes("pg_advisory_xact_lock");
const isCountStatement = (sql: string): boolean => sql.includes("COUNT(*)");

const activeCountResult = (count: number): QueryResult =>
  createQueryResult([{ active_count: String(count) }]);

const readOwnerConnectionMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../../../db/migrations/0068_owner_oauth_connection_management.sql", import.meta.url)),
    "utf8",
  );

test("listAgentConnectionsWithDependencies returns explicitly typed API-key and OAuth rows", async (): Promise<void> => {
  const observedCalls: Array<Readonly<{ sql: string; params: ReadonlyArray<unknown> }>> = [];
  const connections = await listAgentConnectionsWithDependencies(
    "owner-1",
    "workspace-1",
    {
      queryAs: async (_userId, _workspaceId, sql, params): Promise<QueryResult> => {
        observedCalls.push({ sql, params });
        if (sql.includes("auth.agent_api_keys")) {
          return createQueryResult([{
            connection_id: "api-connection-1",
            label: "Terminal",
            created_at: "2026-08-14T10:00:00.000Z",
            last_used_at: "2026-08-15T08:00:00.000Z",
            revoked_at: null,
          }]);
        }
        assert.match(sql, /auth\.list_current_user_oauth_connections\(\)/);
        return createQueryResult([{
          connection_id: "oauth-connection-1",
          client_name: "Claude Desktop",
          created_at: "2026-08-15T10:00:00.000Z",
          last_activity_at: "2026-08-15T10:01:00.000Z",
          revoked_at: null,
        }]);
      },
    },
  );

  assert.deepEqual(connections, [
    {
      type: "oauth",
      connectionId: "oauth-connection-1",
      label: "Claude Desktop",
      createdAt: "2026-08-15T10:00:00.000Z",
      lastActivityAt: "2026-08-15T10:01:00.000Z",
      revokedAt: null,
    },
    {
      type: "api_key",
      connectionId: "api-connection-1",
      label: "Terminal",
      createdAt: "2026-08-14T10:00:00.000Z",
      lastUsedAt: "2026-08-15T08:00:00.000Z",
      revokedAt: null,
    },
  ]);
  assert.deepEqual(observedCalls[0]?.params, ["owner-1"]);
  assert.deepEqual(observedCalls[1]?.params, []);
});

test("revokeAgentConnectionByType calls only the selected credential store", async (): Promise<void> => {
  const calls: Array<string> = [];
  const dependencies: AgentConnectionRevocationDependencies = {
    revokeApiKeyConnection: async (): Promise<boolean> => {
      calls.push("api_key");
      return true;
    },
    revokeOAuthConnection: async (): Promise<boolean> => {
      calls.push("oauth");
      return true;
    },
  };

  assert.equal(
    await revokeAgentConnectionByType("api_key", "owner-1", "workspace-1", "connection-1", dependencies),
    true,
  );
  assert.deepEqual(calls, ["api_key"]);

  calls.length = 0;
  assert.equal(
    await revokeAgentConnectionByType("oauth", "owner-1", "workspace-1", "connection-1", dependencies),
    true,
  );
  assert.deepEqual(calls, ["oauth"]);
});

test("OAuth settings functions enforce session ownership and expose only narrow metadata", (): void => {
  const sql = readOwnerConnectionMigration();

  assert.match(sql, /CREATE FUNCTION auth\.list_current_user_oauth_connections\(\)/);
  assert.match(sql, /CREATE FUNCTION auth\.revoke_current_user_oauth_connection\(p_connection_id TEXT\)/);
  assert.equal(Array.from(sql.matchAll(/current_setting\('app\.user_id', true\)/g)).length, 2);
  assert.match(sql, /WHERE connection\.user_id = v_user_id/);
  assert.match(sql, /AND connection\.user_id = v_user_id/);
  assert.equal(Array.from(sql.matchAll(/SET search_path = pg_catalog, auth, pg_temp/g)).length, 2);
  assert.match(sql, /REVOKE ALL ON FUNCTION auth\.list_current_user_oauth_connections\(\) FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON FUNCTION auth\.revoke_current_user_oauth_connection\(TEXT\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION auth\.list_current_user_oauth_connections\(\) TO app/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION auth\.revoke_current_user_oauth_connection\(TEXT\) TO app/);
  assert.match(sql, /SET revoked_at = COALESCE\(connection\.revoked_at, now\(\)\)/);
  assert.doesNotMatch(sql, /token_hash|code_hash|redirect_uri|scopes/);
  assert.doesNotMatch(sql, /GRANT .* ON TABLE .* TO app/);
});

test("createApiKeyConnectionWithDependencies stores only the hash and returns the key once", async (): Promise<void> => {
  const observedCalls: Array<RecordedStatement> = [];
  const result = await createApiKeyConnectionWithDependencies(
    "owner-1",
    "workspace-1",
    "  Claude Code  ",
    createUserContextDependencies(observedCalls, (sql): QueryResult => {
      if (isLockStatement(sql)) return createQueryResult([]);
      if (isCountStatement(sql)) return activeCountResult(0);
      return createQueryResult([{
        connection_id: "api-connection-2",
        created_at: "2026-09-21T09:00:00.000Z",
      }]);
    }),
  );

  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  const created = result.connection;
  assert.equal(created.connectionId, "api-connection-2");
  assert.equal(created.label, "Claude Code");
  assert.equal(created.createdAt, "2026-09-21T09:00:00.000Z");

  const [prefix, keyId, secret] = created.apiKey.split("_");
  assert.equal(prefix, "ebta");
  assert.match(keyId ?? "", /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.match(secret ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/);

  const insert = observedCalls[2];
  assert.match(insert?.sql ?? "", /INSERT INTO auth\.agent_api_keys/);
  assert.deepEqual(insert?.params, [
    "owner-1",
    "Claude Code",
    keyId,
    createHash("sha256").update(secret ?? "").digest("hex"),
    "workspace-1",
  ]);
  assert.equal(
    (insert?.params ?? []).some((param) => typeof param === "string" && param.includes(secret ?? "x")),
    false,
    "the plaintext secret must never reach the database",
  );
});

test("createApiKeyConnectionWithDependencies locks the user, then counts, then inserts, all in one transaction", async (): Promise<void> => {
  const observedCalls: Array<RecordedStatement> = [];
  await createApiKeyConnectionWithDependencies(
    "owner-1",
    "workspace-1",
    "Claude Code",
    createUserContextDependencies(observedCalls, (sql): QueryResult => {
      if (isLockStatement(sql)) return createQueryResult([]);
      if (isCountStatement(sql)) return activeCountResult(MAX_ACTIVE_API_KEY_CONNECTIONS - 1);
      return createQueryResult([{
        connection_id: "api-connection-3",
        created_at: "2026-09-21T09:00:00.000Z",
      }]);
    }),
  );

  assert.equal(observedCalls.length, 3);
  assert.match(observedCalls[0]?.sql ?? "", /pg_advisory_xact_lock/u);
  assert.deepEqual(observedCalls[0]?.params, ["owner-1"]);
  assert.match(observedCalls[1]?.sql ?? "", /COUNT\(\*\)[\s\S]*auth\.agent_api_keys[\s\S]*revoked_at IS NULL/u);
  assert.match(observedCalls[2]?.sql ?? "", /INSERT INTO auth\.agent_api_keys/u);
  assert.equal(
    observedCalls.some(({ sql }) => /pg_advisory_lock\(/u.test(sql)),
    false,
    "the lock must be transaction-scoped so it always releases with the transaction",
  );
});

test("createApiKeyConnectionWithDependencies refuses over the active key cap without minting anything", async (): Promise<void> => {
  const observedCalls: Array<RecordedStatement> = [];
  const result = await createApiKeyConnectionWithDependencies(
    "owner-1",
    "workspace-1",
    "Claude Code",
    createUserContextDependencies(observedCalls, (sql): QueryResult => {
      if (isLockStatement(sql)) return createQueryResult([]);
      if (isCountStatement(sql)) return activeCountResult(MAX_ACTIVE_API_KEY_CONNECTIONS);
      throw new Error(`no statement may follow the refused count: ${sql}`);
    }),
  );

  assert.deepEqual(result, {
    kind: "refused_active_limit",
    activeCount: MAX_ACTIVE_API_KEY_CONNECTIONS,
    limit: MAX_ACTIVE_API_KEY_CONNECTIONS,
  });
  assert.equal(observedCalls.length, 2, "the refusal must happen before any insert");
});

test("createApiKeyConnectionWithDependencies refuses a blank label before touching the database", async (): Promise<void> => {
  await assert.rejects(
    createApiKeyConnectionWithDependencies("owner-1", "workspace-1", "   ", {
      withUserContext: async (): Promise<never> => {
        throw new Error("the database must not be reached for an invalid label");
      },
    }),
    /Agent connection label must be 1-200 characters/,
  );
});
