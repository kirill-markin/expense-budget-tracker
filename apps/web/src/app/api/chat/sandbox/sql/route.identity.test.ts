import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { QueryResult } from "pg";
import type { DbClient } from "@/server/db/contextRunner";

/**
 * The route's real wiring, down to the pool: the proxy strips identity headers
 * on this path, so any request-header read is a production 500.
 */

type RecordedCommand = Readonly<{
  connection: number;
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type PoolScript = {
  commands: Array<RecordedCommand>;
  memberWorkspaceIds: ReadonlySet<string>;
  requestHeaderReads: number;
};

const STORED_USER = {
  user_id: "user-1",
  email: "stored@example.com",
  email_verified: true,
  cognito_status: "CONFIRMED",
  cognito_enabled: true,
} as const;

const CAPABILITY = {
  activeRunId: "run-1",
  sessionId: "session-1",
  userId: STORED_USER.user_id,
  workspaceId: "workspace-1",
} as const;

const script: PoolScript = {
  commands: [],
  memberWorkspaceIds: new Set(),
  requestHeaderReads: 0,
};

const result = (command: string, rows: ReadonlyArray<Readonly<Record<string, unknown>>>, rowCount: number): QueryResult => ({
  command,
  rowCount,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const answer = (text: string, params: ReadonlyArray<unknown>): QueryResult => {
  if (/FROM users\s+WHERE user_id = \$1/.test(text)) {
    return params[0] === STORED_USER.user_id ? result("SELECT", [STORED_USER], 1) : result("SELECT", [], 0);
  }
  if (text.includes("FROM workspace_members WHERE workspace_id = $1 AND user_id = $2")) {
    return script.memberWorkspaceIds.has(String(params[0])) ? result("SELECT", [{ "?column?": 1 }], 1) : result("SELECT", [], 0);
  }
  if (text.includes("FROM workspace_settings WHERE workspace_id = $1")) {
    return result("SELECT", [{ "?column?": 1 }], 1);
  }
  if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
    return result("SELECT", [{ session_id: CAPABILITY.sessionId, status: "running", active_run_id: CAPABILITY.activeRunId }], 1);
  }
  if (text.includes("FROM workspaces w")) {
    return result("SELECT", [{ workspace_id: CAPABILITY.workspaceId, name: "Personal" }], 1);
  }
  if (text.startsWith("FETCH FORWARD")) {
    return result("FETCH", [{ account_id: "account-1" }], 1);
  }
  if (text.startsWith("DELETE FROM ledger_entries")) {
    return result("DELETE", [], 1);
  }
  return result("SELECT", [], 0);
};

let connections = 0;

mock.module("@/server/db/pool", {
  namedExports: {
    query: async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
      script.commands.push({ connection: 0, text, params });
      return answer(text, params);
    },
    getPool: () => ({
      connect: async (): Promise<DbClient> => {
        connections += 1;
        const connection = connections;
        return {
          query: async (text: string, params?: Array<unknown>): Promise<QueryResult> => {
            script.commands.push({ connection, text, params: params ?? [] });
            return answer(text, params ?? []);
          },
          release: (): void => {},
        };
      },
    }),
  },
});

mock.module("next/headers", {
  namedExports: {
    headers: async (): Promise<never> => {
      script.requestHeaderReads += 1;
      throw new Error("The proxy strips identity headers on the chat sandbox SQL path");
    },
    cookies: async () => ({ get: (): undefined => undefined }),
  },
});

// Imported only after the mocks above are in place.
const loadRoute = async (): Promise<Readonly<{
  POST: typeof import("@/app/api/chat/sandbox/sql/route").POST;
  mintChatSandboxSqlBridge: typeof import("@/server/chat/sandbox/sqlCapability").mintChatSandboxSqlBridge;
}>> => ({
  POST: (await import("@/app/api/chat/sandbox/sql/route")).POST,
  mintChatSandboxSqlBridge: (await import("@/server/chat/sandbox/sqlCapability")).mintChatSandboxSqlBridge,
});

const withScript = async (memberWorkspaceIds: ReadonlyArray<string>, run: () => Promise<void>): Promise<void> => {
  script.commands = [];
  script.memberWorkspaceIds = new Set(memberWorkspaceIds);
  script.requestHeaderReads = 0;
  const snapshot = {
    CHAT_SANDBOX_BRIDGE_SECRET: process.env.CHAT_SANDBOX_BRIDGE_SECRET,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
  };
  Reflect.set(process.env, "CHAT_SANDBOX_BRIDGE_SECRET", "s".repeat(64));
  Reflect.set(process.env, "CORS_ORIGIN", "https://app.example.com");
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        Reflect.set(process.env, key, value);
      }
    }
  }
};

const postSql = async (kind: "query" | "execute", sql: string): Promise<Response> => {
  const { POST, mintChatSandboxSqlBridge } = await loadRoute();
  const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, Date.now());
  return POST(new Request("https://app.example.com/api/chat/sandbox/sql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ kind, sql, workspaceId: null }),
  }));
};

/** Every command of the connection that issued the first command matching `pattern`. */
const connectionOf = (pattern: RegExp): ReadonlyArray<RecordedCommand> => {
  const issued = script.commands.find((command) => pattern.test(command.text));
  assert.ok(issued, `no command matched ${String(pattern)}`);
  return script.commands.filter((command) => command.connection === issued.connection);
};

const appUserIdOf = (commands: ReadonlyArray<RecordedCommand>): unknown =>
  commands.find((command) => command.text.includes("set_config('app.user_id'"))?.params[0];

const identityUpserts = (): ReadonlyArray<ReadonlyArray<unknown>> =>
  script.commands.filter((command) => command.text.includes("INSERT INTO users")).map((command) => command.params);

const STORED_IDENTITY_PARAMS = [
  STORED_USER.user_id,
  STORED_USER.email,
  STORED_USER.email_verified,
  STORED_USER.cognito_status,
  STORED_USER.cognito_enabled,
];

test("a query runs for the capability's stored identity without request headers", async (): Promise<void> => {
  await withScript([CAPABILITY.workspaceId], async (): Promise<void> => {
    const response = await postSql("query", "SELECT account_id FROM accounts");

    assert.equal(response.status, 200, await response.clone().text());
    const body = JSON.parse(await response.text()) as Readonly<{
      ok: boolean;
      data: Readonly<{ statements: ReadonlyArray<Readonly<{ rows: ReadonlyArray<unknown> }>> }>;
    }>;
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.statements[0]?.rows, [{ account_id: "account-1" }]);
    assert.equal(script.requestHeaderReads, 0);
    // The active-run gate and the statement each provision the stored identity, unchanged.
    assert.deepEqual(identityUpserts(), [STORED_IDENTITY_PARAMS, STORED_IDENTITY_PARAMS]);
    const gate = connectionOf(/FROM public\.chat_sessions/);
    assert.equal(appUserIdOf(gate), CAPABILITY.userId);
    const read = connectionOf(/^DECLARE /);
    assert.equal(appUserIdOf(read), CAPABILITY.userId);
    assert.ok(read.some((command) => command.text === "SET LOCAL ROLE api_sql_reader"));
  });
});

test("an execute runs for the capability's stored identity without request headers", async (): Promise<void> => {
  await withScript([CAPABILITY.workspaceId], async (): Promise<void> => {
    const response = await postSql("execute", "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'");

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((JSON.parse(await response.text()) as Readonly<{ ok: boolean }>).ok, true);
    assert.equal(script.requestHeaderReads, 0);
    assert.deepEqual(identityUpserts(), [STORED_IDENTITY_PARAMS, STORED_IDENTITY_PARAMS]);
    const mutation = connectionOf(/^DELETE FROM ledger_entries/);
    assert.equal(appUserIdOf(mutation), CAPABILITY.userId);
    assert.ok(mutation.some((command) => command.text === "SET LOCAL ROLE api_sql_executor"));
  });
});

test("a user no longer in the session workspace is refused before any statement runs", async (): Promise<void> => {
  await withScript([], async (): Promise<void> => {
    const response = await postSql("execute", "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'");

    assert.equal(response.status, 403);
    assert.match(await response.text(), /no longer a member of its workspace/);
    assert.equal(script.requestHeaderReads, 0);
    assert.equal(script.commands.some((command) => /^(DELETE|DECLARE)/.test(command.text)), false);
  });
});
