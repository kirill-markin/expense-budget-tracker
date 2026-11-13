import assert from "node:assert/strict";
import test from "node:test";
import {
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import type { ValidatedExpenseSql } from "@expense-budget-tracker/agent-shared/sql-policy";
import { chatSandboxSqlRouteWithDeps } from "@/app/api/chat/sandbox/sql/route";
import { ApiRouteError } from "@/server/api/errors";
import {
  executeChatToolCallWithDependencies,
  type ChatSqlCallDependencies,
  type OpenAIToolContext,
} from "@/server/chat/openai/tooling/tools";
import {
  mintChatSandboxSqlBridge,
  type ChatSandboxSqlCapability,
} from "@/server/chat/sandbox/sqlCapability";
import type {
  ChatSqlExecutionContext,
  ChatSqlTarget,
  QueryResult,
} from "@/server/chat/shared";
import type { WorkspaceSummary } from "@/server/workspaces";

type RouteDependencies = Parameters<typeof chatSandboxSqlRouteWithDeps>[1];

const NOW_MS = 1_800_000_000_000;
const READ_SQL = "SELECT account_id FROM accounts";
const MUTATION_SQL = "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'";

const WORKSPACES: ReadonlyArray<WorkspaceSummary> = [
  { workspaceId: "workspace-1", name: "Personal" },
  { workspaceId: "workspace-2", name: "Business" },
];

const CAPABILITY: ChatSandboxSqlCapability = {
  activeRunId: "run-1",
  sessionId: "session-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};

type SqlExecution = Readonly<{
  validated: ValidatedExpenseSql;
  context: ChatSqlExecutionContext;
  target: ChatSqlTarget;
}>;

type RecordedSql = Readonly<{
  executions: Array<SqlExecution>;
  logs: Array<string>;
  dependencies: ChatSqlCallDependencies;
}>;

const createRecordedSql = (): RecordedSql => {
  const executions: Array<SqlExecution> = [];
  const logs: Array<string> = [];
  return {
    executions,
    logs,
    dependencies: {
      execQuery: async (validated, context, target): Promise<QueryResult> => {
        executions.push({ validated, context, target });
        return {
          json: JSON.stringify({
            ok: true,
            data: { workspace: target.workspace, statements: [] },
            instructions: target.instructions,
          }),
        };
      },
      listChatWorkspaces: async (): Promise<ReadonlyArray<WorkspaceSummary>> => WORKSPACES,
      log: (event): void => {
        logs.push(JSON.stringify(event));
      },
    },
  };
};

const withBridgeEnv = async (run: () => Promise<void>): Promise<void> => {
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

const createSqlRequest = (authorization: string, body: unknown): Request =>
  new Request("https://app.example.com/api/chat/sandbox/sql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(body),
  });

const createRouteDependencies = (
  sql: ChatSqlCallDependencies,
  routeLogs: Array<string>,
  requireActiveChatRun: RouteDependencies["requireActiveChatRun"],
): RouteDependencies => ({
  now: (): number => NOW_MS,
  createRequestId: (): string => "request-1",
  requireActiveChatRun,
  sql,
  log: (event): void => {
    routeLogs.push(JSON.stringify(event));
  },
});

const unusedChatOnlyDependency = async (): Promise<never> => {
  throw new Error("Only the SQL tools may run in this test");
};

/** The answer the chat's own tool gives for the same statement from the same run. */
const runChatTool = async (
  toolName: string,
  sql: string,
  recorded: RecordedSql,
): Promise<string> => {
  const context: OpenAIToolContext = {
    requestId: "request-1",
    userId: CAPABILITY.userId,
    workspaceId: CAPABILITY.workspaceId,
    sessionId: CAPABILITY.sessionId,
    turnId: CAPABILITY.activeRunId,
    toolCallId: "call-1",
    isDemoMode: false,
  };
  const result = await executeChatToolCallWithDependencies(
    toolName,
    JSON.stringify({ sql, workspaceId: null }),
    context,
    {
      ...recorded.dependencies,
      loadAllowedSchemaForChatWorkspace: unusedChatOnlyDependency,
      runChatSandboxCommand: unusedChatOnlyDependency,
      viewChatFile: unusedChatOnlyDependency,
    },
  );
  return result.output;
};

test("the route runs a query and an execute exactly as the chat SQL tools do", async (): Promise<void> => {
  await withBridgeEnv(async (): Promise<void> => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const cases = [
      { kind: "query", toolName: SQL_QUERY_TOOL.name, sql: READ_SQL },
      { kind: "execute", toolName: SQL_EXECUTE_TOOL.name, sql: MUTATION_SQL },
      { kind: "query", toolName: SQL_QUERY_TOOL.name, sql: MUTATION_SQL },
    ] as const;

    for (const testCase of cases) {
      const bridgeSql = createRecordedSql();
      const routeLogs: Array<string> = [];
      const response = await chatSandboxSqlRouteWithDeps(
        createSqlRequest(authorization, { kind: testCase.kind, sql: testCase.sql, workspaceId: null }),
        createRouteDependencies(bridgeSql.dependencies, routeLogs, async (): Promise<void> => {}),
      );
      const chatSql = createRecordedSql();
      const chatOutput = await runChatTool(testCase.toolName, testCase.sql, chatSql);

      assert.equal(response.status, 200);
      assert.equal(await response.text(), chatOutput);
      const statementAndTarget = (execution: SqlExecution): Omit<SqlExecution, "context"> => ({
        validated: execution.validated,
        target: execution.target,
      });
      assert.deepEqual(
        bridgeSql.executions.map(statementAndTarget),
        chatSql.executions.map(statementAndTarget),
      );
      assert.deepEqual(bridgeSql.logs, chatSql.logs);
      assert.equal(routeLogs.length, 1);
      const logged = JSON.parse(String(routeLogs[0])) as Record<string, unknown>;
      assert.equal(logged.action, "sandbox_sql");
      assert.equal(logged.kind, testCase.kind);
      assert.equal(logged.sql, testCase.sql);
      assert.equal(logged.activeRunId, CAPABILITY.activeRunId);
    }
  });
});

test("the route runs the statement for the capability's run and session workspace", async (): Promise<void> => {
  await withBridgeEnv(async (): Promise<void> => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const bridgeSql = createRecordedSql();
    const routeLogs: Array<string> = [];

    const response = await chatSandboxSqlRouteWithDeps(
      createSqlRequest(authorization, { kind: "execute", sql: MUTATION_SQL, workspaceId: "workspace-2" }),
      createRouteDependencies(bridgeSql.dependencies, routeLogs, async (): Promise<void> => {}),
    );

    assert.equal(response.status, 200);
    const execution = bridgeSql.executions[0];
    assert.ok(execution);
    assert.equal(execution.context.userId, CAPABILITY.userId);
    assert.equal(execution.context.workspaceId, CAPABILITY.workspaceId);
    assert.equal(execution.context.sessionId, CAPABILITY.sessionId);
    assert.equal(execution.context.turnId, CAPABILITY.activeRunId);
    assert.equal(execution.target.workspace.workspaceId, "workspace-2");
    assert.deepEqual(JSON.parse(String(routeLogs[0])), {
      domain: "chat",
      action: "sandbox_sql",
      kind: "execute",
      outcome: "succeeded",
      errorCode: null,
      sql: MUTATION_SQL,
      sqlChars: MUTATION_SQL.length,
      durationMs: 0,
      requestId: "request-1",
      userId: CAPABILITY.userId,
      workspaceId: CAPABILITY.workspaceId,
      sessionId: CAPABILITY.sessionId,
      activeRunId: CAPABILITY.activeRunId,
    });
  });
});

test("the route refuses a run that is no longer the session's running run", async (): Promise<void> => {
  await withBridgeEnv(async (): Promise<void> => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const bridgeSql = createRecordedSql();
    const routeLogs: Array<string> = [];
    const checkedRuns: Array<ChatSandboxSqlCapability> = [];

    const response = await chatSandboxSqlRouteWithDeps(
      createSqlRequest(authorization, { kind: "query", sql: READ_SQL, workspaceId: null }),
      createRouteDependencies(bridgeSql.dependencies, routeLogs, async (capability): Promise<void> => {
        checkedRuns.push(capability);
        throw new ApiRouteError(403, "The chat run this command belongs to is no longer running");
      }),
    );

    assert.equal(response.status, 403);
    assert.deepEqual(checkedRuns, [CAPABILITY]);
    assert.deepEqual(bridgeSql.executions, []);
    assert.deepEqual(routeLogs, []);
  });
});

test("the route accepts only a valid capability and a strict body", async (): Promise<void> => {
  await withBridgeEnv(async (): Promise<void> => {
    const { authorization } = mintChatSandboxSqlBridge(CAPABILITY, NOW_MS);
    const bridgeSql = createRecordedSql();
    const routeLogs: Array<string> = [];
    const dependencies = createRouteDependencies(bridgeSql.dependencies, routeLogs, async (): Promise<void> => {});
    const body = { kind: "query", sql: READ_SQL, workspaceId: null };

    const unsigned = await chatSandboxSqlRouteWithDeps(createSqlRequest("Bearer token", body), dependencies);
    const tampered = await chatSandboxSqlRouteWithDeps(createSqlRequest(`${authorization}x`, body), dependencies);
    const extraField = await chatSandboxSqlRouteWithDeps(
      createSqlRequest(authorization, { ...body, rows: [] }),
      dependencies,
    );
    const unknownKind = await chatSandboxSqlRouteWithDeps(
      createSqlRequest(authorization, { ...body, kind: "script" }),
      dependencies,
    );

    assert.equal(unsigned.status, 401);
    assert.equal(tampered.status, 401);
    assert.equal(extraField.status, 400);
    assert.equal(unknownKind.status, 400);
    assert.deepEqual(bridgeSql.executions, []);
    assert.deepEqual(routeLogs, []);
  });
});
