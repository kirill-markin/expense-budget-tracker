import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResult } from "pg";

import {
  listAgentConnectionsWithDependencies,
  revokeAgentConnectionByType,
  type AgentConnectionRevocationDependencies,
} from "@/server/agent/connections";

const createQueryResult = (
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

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
