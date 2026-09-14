import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  SQL_DIALECT_GUIDE,
  WRITING_DATA_GUIDE,
} from "@expense-budget-tracker/agent-shared/agent-protocol";
import {
  MAX_SQL_RESULT_CHARS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { SqlTransactionOutcomeUnknownError } from "../dbDeadline.js";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import { MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS, type McpServerDependencies } from "./server.js";
import { withMcpClient } from "./testClient.js";

const PERSONAL_WORKSPACE_ID = "workspace-personal";
const BUSINESS_WORKSPACE_ID = "workspace-business";

type ToolCalls = {
  listedUserIds: Array<string>;
  membershipWorkspaceIds: Array<string>;
  schemaWorkspaceIds: Array<string>;
  queriedWorkspaceIds: Array<string>;
  executedWorkspaceIds: Array<string>;
  workspaceDeadlines: Array<SqlExecutionDeadline>;
  schemaDeadlines: Array<SqlExecutionDeadline>;
  queryDeadlines: Array<SqlExecutionDeadline>;
  executeDeadlines: Array<SqlExecutionDeadline>;
};

type JsonObject = Readonly<Record<string, unknown>>;

type ExpectedToolDescriptor = Readonly<{
  name: string;
  title: string;
  description: string;
  inputProperties: ReadonlyArray<string>;
  requiredInputProperties: ReadonlyArray<string>;
  scopes: ReadonlyArray<"expenses:read" | "expenses:write">;
  maxResultSizeChars: number | null;
}>;

const EXPECTED_TOOL_DESCRIPTORS: ReadonlyArray<ExpectedToolDescriptor> = [
  {
    name: "list_workspaces",
    title: "List accessible workspaces",
    description: "Use this read-only discovery tool to list every workspace accessible to the authenticated user. It does not create or modify workspaces; pass a returned workspaceId to other tools when more than one is available.",
    inputProperties: [],
    requiredInputProperties: [],
    scopes: ["expenses:read"],
    maxResultSizeChars: null,
  },
  {
    name: "get_schema",
    title: "Inspect expense SQL schema",
    description: "Use this read-only discovery tool before writing SQL to inspect allowed relations, columns, constraints, and per-relation agent hints for an accessible workspace, including the write semantics of ledger_entries. It does not expose or query system catalogs.",
    inputProperties: ["workspaceId"],
    requiredInputProperties: [],
    scopes: ["expenses:read"],
    maxResultSizeChars: null,
  },
  {
    name: "get_guide",
    title: "Fetch expense usage protocol",
    description: "Use this read-only tool to fetch the current usage protocol for this workspace data model before acting on it. It returns guidance text only and never reads or changes workspace data. Call it with topic writing_data before the first INSERT, UPDATE, or DELETE of a task, including any bank statement or CSV import, and with topic sql_dialect before writing SQL against this restricted surface.",
    inputProperties: ["topic"],
    requiredInputProperties: ["topic"],
    scopes: ["expenses:read"],
    maxResultSizeChars: null,
  },
  {
    name: "sql_query",
    title: "Query expense data",
    description: "Use this read-only query tool to run exactly one policy-approved SELECT or WITH...SELECT statement against an accessible workspace. Use it to read existing accounts, categories, and entries before a write, and to verify row counts and balances after a write. It executes in a repeatable-read, read-only transaction under the restricted SQL reader role.",
    inputProperties: ["sql", "workspaceId"],
    requiredInputProperties: ["sql"],
    scopes: ["expenses:read"],
    maxResultSizeChars: MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS,
  },
  {
    name: "sql_execute",
    title: "Execute expense data mutation",
    description: "Use this write-capable tool only for a mutation the user explicitly approved. Call get_guide with topic writing_data before the first mutation of a task: it defines duplicate checks, transfer pairs, category reuse, probe-then-batch execution, and post-write verification. This tool runs exactly one policy-approved INSERT, UPDATE, or DELETE statement under the restricted SQL executor role and may destructively modify workspace data.",
    inputProperties: ["sql", "workspaceId"],
    requiredInputProperties: ["sql"],
    scopes: ["expenses:read", "expenses:write"],
    maxResultSizeChars: MCP_SQL_TOOL_MAX_RESULT_SIZE_CHARS,
  },
];

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseToolPayload = (result: Awaited<ReturnType<Client["callTool"]>>): JsonObject => {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.ok(isJsonObject(content));
  assert.equal(content["type"], "text");
  const text = content["text"];
  assert.equal(typeof text, "string");
  const payload: unknown = JSON.parse(text as string);
  assert.ok(isJsonObject(payload));
  return payload;
};

const readSuccessPayload = (
  result: Awaited<ReturnType<Client["callTool"]>>,
): JsonObject => {
  const payload = parseToolPayload(result);
  assert.notEqual(result.isError, true);
  assert.equal(payload["ok"], true);
  return payload;
};

const requireJsonObject = (value: unknown, message: string): JsonObject => {
  assert.ok(isJsonObject(value), message);
  return value;
};

const requireTool = (tools: ReadonlyArray<Tool>, name: string): Tool => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool !== undefined, `Expected tools/list to include ${name}`);
  return tool;
};

const assertToolInputSchema = (
  tool: Tool,
  expected: ExpectedToolDescriptor,
): void => {
  const inputProperties = requireJsonObject(
    tool.inputSchema.properties ?? {},
    `Expected ${tool.name} input properties`,
  );
  assert.deepEqual(Object.keys(inputProperties).sort(), [...expected.inputProperties].sort());
  assert.deepEqual(tool.inputSchema.required ?? [], expected.requiredInputProperties);
};

const readErrorCode = (payload: JsonObject): string => {
  const error = payload["error"];
  assert.ok(isJsonObject(error));
  const code = error["code"];
  assert.equal(typeof code, "string");
  return code as string;
};

const createConnection = (
  scopes: AuthenticatedMcpAccessToken["scopes"],
): AuthenticatedMcpAccessToken => ({
  connectionId: "connection-1",
  clientId: "client-1",
  resource: "https://mcp.example.com/mcp",
  scopes,
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
});

const createDependencies = (
  workspaceIds: ReadonlyArray<string>,
  calls: ToolCalls,
): McpServerDependencies => ({
  listWorkspaces: async (identity, deadline) => {
    calls.listedUserIds.push(identity.userId);
    calls.workspaceDeadlines.push(deadline);
    return workspaceIds.map((workspaceId) => ({
      workspaceId,
      name: workspaceId === PERSONAL_WORKSPACE_ID ? "Personal" : "Business",
    }));
  },
  getWorkspace: async (_identity, workspaceId) => {
    calls.membershipWorkspaceIds.push(workspaceId);
    if (!workspaceIds.includes(workspaceId)) {
      return null;
    }
    return {
      workspaceId,
      name: workspaceId === PERSONAL_WORKSPACE_ID ? "Personal" : "Business",
    };
  },
  loadAllowedSchemaForWorkspace: async (_identity, workspaceId, deadline) => {
    calls.schemaWorkspaceIds.push(workspaceId);
    calls.schemaDeadlines.push(deadline);
    return [{
      name: "ledger_entries",
      columns: [{
        name: "amount",
        type: "numeric",
        nullable: false,
        defaultValue: null,
      }],
      hints: {
        optional: false,
        notes: ["One row per account movement."],
      },
    }];
  },
  validateSingleReadOnlyExpenseSql,
  validateSingleMutationExpenseSql,
  runReadOnlySql: async (_authenticated, workspaceId, validated, deadline) => {
    calls.queriedWorkspaceIds.push(workspaceId);
    calls.queryDeadlines.push(deadline);
    return {
      statements: [{
        sql: validated.sql,
        command: "SELECT",
        rows: [{
          amount: "10.00",
          postedAt: new Date("2026-08-14T12:00:00.000Z"),
        }],
        rowCount: 1,
        returnedRowCount: 1,
        totalRowCount: 1,
        truncated: false,
        referencedRelations: ["ledger_entries"],
      }],
      workspace: { workspaceId, name: "Personal" },
      limits: {
        maxRows: 100,
        maxResultChars: MAX_SQL_RESULT_CHARS,
        statementTimeoutMs: deadline.timeoutMs,
      },
    };
  },
  runSql: async (_authenticated, workspaceId, validated, deadline) => {
    calls.executedWorkspaceIds.push(workspaceId);
    calls.executeDeadlines.push(deadline);
    return {
      statements: [{
        sql: validated.sql,
        command: "DELETE",
        rows: [],
        rowCount: 1,
        returnedRowCount: 0,
        totalRowCount: 1,
        truncated: false,
        referencedRelations: ["budget_lines"],
      }],
      workspace: { workspaceId, name: "Personal" },
      limits: {
        maxRows: 100,
        maxResultChars: MAX_SQL_RESULT_CHARS,
        statementTimeoutMs: deadline.timeoutMs,
      },
    };
  },
});

const createCalls = (): ToolCalls => ({
  listedUserIds: [],
  membershipWorkspaceIds: [],
  schemaWorkspaceIds: [],
  queriedWorkspaceIds: [],
  executedWorkspaceIds: [],
  workspaceDeadlines: [],
  schemaDeadlines: [],
  queryDeadlines: [],
  executeDeadlines: [],
});

const withClient = (
  connection: AuthenticatedMcpAccessToken,
  dependencies: McpServerDependencies,
  callback: (client: Client) => Promise<void>,
): Promise<void> => withMcpClient("mcp-server-test", connection, dependencies, callback);

test("MCP server emits the public runtime contract and routes successful tool calls", async (): Promise<void> => {
  const calls = createCalls();
  const dependencies = createDependencies(
    [PERSONAL_WORKSPACE_ID, BUSINESS_WORKSPACE_ID],
    calls,
  );

  await withClient(
    createConnection(["expenses:read", "expenses:write"]),
    dependencies,
    async (client): Promise<void> => {
      const tools = (await client.listTools()).tools;
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        EXPECTED_TOOL_DESCRIPTORS.map((tool) => tool.name).sort(),
      );
      for (const expected of EXPECTED_TOOL_DESCRIPTORS) {
        const tool = requireTool(tools, expected.name);
        assert.equal(tool.title, expected.title);
        assert.equal(tool.description, expected.description);
        assertToolInputSchema(tool, expected);
        assert.deepEqual(tool._meta, {
          securitySchemes: [{ type: "oauth2", scopes: expected.scopes }],
          ...(expected.maxResultSizeChars === null
            ? {}
            : { "anthropic/maxResultSizeChars": expected.maxResultSizeChars }),
        });
        assert.equal(Object.prototype.hasOwnProperty.call(tool, "securitySchemes"), false);
      }

      for (const toolName of ["get_guide", "get_schema", "list_workspaces", "sql_query"]) {
        assert.deepEqual(requireTool(tools, toolName).annotations, {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      assert.deepEqual(requireTool(tools, "sql_execute").annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });

      assert.deepEqual(client.getServerVersion(), {
        name: "expense-budget-tracker",
        version: "1.7.0",
        title: "Expense Budget Tracker",
        websiteUrl: "https://expense-budget-tracker.com/",
        icons: [{
          src: "https://expense-budget-tracker.com/icon.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"],
        }],
      });
      const instructions = client.getInstructions();
      assert.equal(typeof instructions, "string");
      for (const requiredText of [
        "list_workspaces",
        "workspaceId",
        "get_schema",
        "get_guide",
        "writing_data",
        "sql_dialect",
        "sql_query",
        "expenses:read",
        "sql_execute",
        "expenses:write",
        "https://api.expense-budget-tracker.com/v1/",
        "/v1/openapi.json",
        "/v1/swagger.json",
        "source-discovery compatibility probes",
      ]) {
        assert.equal(instructions?.includes(requiredText), true, requiredText);
      }

      const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
      readSuccessPayload(listed);
      const schema = await client.callTool({
        name: "get_schema",
        arguments: { workspaceId: BUSINESS_WORKSPACE_ID },
      });
      readSuccessPayload(schema);
      const query = await client.callTool({
        name: "sql_query",
        arguments: {
          workspaceId: PERSONAL_WORKSPACE_ID,
          sql: "SELECT amount FROM ledger_entries",
        },
      });
      const queryPayload = readSuccessPayload(query);
      const queryData = requireJsonObject(queryPayload["data"], "Expected sql_query data");
      const queryStatements = queryData["statements"];
      assert.ok(Array.isArray(queryStatements));
      const queryStatement = requireJsonObject(queryStatements[0], "Expected sql_query statement");
      const queryRows = queryStatement["rows"];
      assert.ok(Array.isArray(queryRows));
      const queryRow = requireJsonObject(queryRows[0], "Expected sql_query row");
      assert.equal(queryRow["postedAt"], "2026-08-14T12:00:00.000Z");
      const execute = await client.callTool({
        name: "sql_execute",
        arguments: {
          workspaceId: BUSINESS_WORKSPACE_ID,
          sql: "DELETE FROM budget_lines WHERE category = 'Food'",
        },
      });
      readSuccessPayload(execute);
    },
  );

  assert.deepEqual(calls.schemaWorkspaceIds, [BUSINESS_WORKSPACE_ID]);
  assert.deepEqual(calls.queriedWorkspaceIds, [PERSONAL_WORKSPACE_ID]);
  assert.deepEqual(calls.executedWorkspaceIds, [BUSINESS_WORKSPACE_ID]);
  assert.equal(calls.workspaceDeadlines.length, 4);
  assert.equal(calls.schemaDeadlines[0], calls.workspaceDeadlines[1]);
  assert.equal(calls.queryDeadlines[0], calls.workspaceDeadlines[2]);
  assert.equal(calls.executeDeadlines[0], calls.workspaceDeadlines[3]);
  assert.deepEqual(
    calls.workspaceDeadlines.map((deadline) => deadline.timeoutMs),
    Array.from({ length: 4 }, () => MCP_SQL_STATEMENT_TIMEOUT_MS),
  );
  assert.equal(
    calls.workspaceDeadlines.every((deadline) => deadline === calls.workspaceDeadlines[0]),
    true,
  );
});

test("get_guide serves the shared protocol text without reaching any data service", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:read"]),
    createDependencies([PERSONAL_WORKSPACE_ID, BUSINESS_WORKSPACE_ID], calls),
    async (client): Promise<void> => {
      for (const [topic, guide] of [
        ["sql_dialect", SQL_DIALECT_GUIDE],
        ["writing_data", WRITING_DATA_GUIDE],
      ] as const) {
        const result = await client.callTool({ name: "get_guide", arguments: { topic } });
        const data = requireJsonObject(
          readSuccessPayload(result)["data"],
          `Expected get_guide ${topic} data`,
        );
        assert.equal(data["topic"], topic);
        assert.equal(data["guide"], guide);
      }
    },
  );

  assert.deepEqual(calls.listedUserIds, []);
  assert.deepEqual(calls.workspaceDeadlines, []);
});

test("MCP tools require explicit workspace membership when selection is ambiguous", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:read", "expenses:write"]),
    createDependencies([PERSONAL_WORKSPACE_ID, BUSINESS_WORKSPACE_ID], calls),
    async (client): Promise<void> => {
      const ambiguous = await client.callTool({
        name: "sql_query",
        arguments: { sql: "SELECT amount FROM ledger_entries" },
      });
      assert.equal(ambiguous.isError, true);
      assert.equal(readErrorCode(parseToolPayload(ambiguous)), "workspace_selection_required");

      const inaccessible = await client.callTool({
        name: "get_schema",
        arguments: { workspaceId: "workspace-other" },
      });
      assert.equal(inaccessible.isError, true);
      assert.equal(readErrorCode(parseToolPayload(inaccessible)), "workspace_not_found");
    },
  );
  assert.deepEqual(calls.schemaWorkspaceIds, []);
  assert.deepEqual(calls.queriedWorkspaceIds, []);
  assert.deepEqual(
    calls.workspaceDeadlines.map((deadline) => deadline.timeoutMs),
    [MCP_SQL_STATEMENT_TIMEOUT_MS, MCP_SQL_STATEMENT_TIMEOUT_MS],
  );
});

test("MCP read tools preserve an empty workspace list without provisioning state", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:read"]),
    createDependencies([], calls),
    async (client): Promise<void> => {
      const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
      const listedPayload = parseToolPayload(listed);
      assert.equal(listedPayload["ok"], true);
      const listedData = listedPayload["data"];
      assert.ok(isJsonObject(listedData));
      assert.deepEqual(listedData["workspaces"], []);

      const schema = await client.callTool({ name: "get_schema", arguments: {} });
      assert.equal(schema.isError, true);
      assert.equal(readErrorCode(parseToolPayload(schema)), "no_workspaces");

      const query = await client.callTool({
        name: "sql_query",
        arguments: { sql: "SELECT account_id FROM accounts" },
      });
      assert.equal(query.isError, true);
      assert.equal(readErrorCode(parseToolPayload(query)), "no_workspaces");
    },
  );

  assert.deepEqual(calls.schemaWorkspaceIds, []);
  assert.deepEqual(calls.queriedWorkspaceIds, []);
  assert.deepEqual(calls.executedWorkspaceIds, []);
  assert.deepEqual(
    calls.workspaceDeadlines.map((deadline) => deadline.timeoutMs),
    [
      MCP_SQL_STATEMENT_TIMEOUT_MS,
      MCP_SQL_STATEMENT_TIMEOUT_MS,
      MCP_SQL_STATEMENT_TIMEOUT_MS,
    ],
  );
});

test("MCP tools enforce read and write scopes before service execution", async (): Promise<void> => {
  const readOnlyCalls = createCalls();
  await withClient(
    createConnection(["expenses:read"]),
    createDependencies([PERSONAL_WORKSPACE_ID], readOnlyCalls),
    async (client): Promise<void> => {
      const result = await client.callTool({
        name: "sql_execute",
        arguments: {
          sql: "DELETE FROM budget_lines WHERE category = 'Food'",
        },
      });
      assert.equal(result.isError, true);
      assert.equal(readErrorCode(parseToolPayload(result)), "insufficient_scope");
    },
  );
  assert.deepEqual(readOnlyCalls.executedWorkspaceIds, []);

  const writeOnlyCalls = createCalls();
  await withClient(
    createConnection(["expenses:write"]),
    createDependencies([PERSONAL_WORKSPACE_ID], writeOnlyCalls),
    async (client): Promise<void> => {
      const result = await client.callTool({ name: "list_workspaces", arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(readErrorCode(parseToolPayload(result)), "insufficient_scope");
    },
  );
  assert.deepEqual(writeOnlyCalls.listedUserIds, []);
});

test("sql_query preserves read-only policy errors without calling the SQL runner", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:read"]),
    createDependencies([PERSONAL_WORKSPACE_ID], calls),
    async (client): Promise<void> => {
      const result = await client.callTool({
        name: "sql_query",
        arguments: { sql: "DELETE FROM ledger_entries" },
      });
      assert.equal(result.isError, true);
      assert.equal(readErrorCode(parseToolPayload(result)), "read_only_sql_required");
    },
  );
  assert.deepEqual(calls.queriedWorkspaceIds, []);
  assert.deepEqual(calls.workspaceDeadlines, []);
});

test("readonly MCP tools unwrap transaction deadline uncertainty as request deadlines", async (): Promise<void> => {
  const calls = createCalls();
  const dependencies: McpServerDependencies = {
    ...createDependencies([PERSONAL_WORKSPACE_ID], calls),
    listWorkspaces: async () => {
      throw new SqlTransactionOutcomeUnknownError(
        "commit",
        new SqlExecutionDeadlineError(MCP_SQL_STATEMENT_TIMEOUT_MS),
        "unknown",
        undefined,
      );
    },
  };

  await withClient(
    createConnection(["expenses:read"]),
    dependencies,
    async (client): Promise<void> => {
      const result = await client.callTool({ name: "list_workspaces", arguments: {} });
      const payload = parseToolPayload(result);
      const error = payload["error"];
      assert.ok(isJsonObject(error));
      assert.equal(result.isError, true);
      assert.equal(error["code"], "request_deadline_exceeded");
      assert.deepEqual(error["details"], { timeoutMs: 20_000, retryable: true });
    },
  );
});

test("sql_execute rejects readonly SQL before workspace resolution or execution", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:write"]),
    createDependencies([PERSONAL_WORKSPACE_ID], calls),
    async (client): Promise<void> => {
      for (const sql of [
        "SELECT account_id FROM accounts",
        "WITH target AS (SELECT account_id FROM accounts) SELECT account_id FROM target",
      ]) {
        const result = await client.callTool({
          name: "sql_execute",
          arguments: { sql },
        });
        const payload = parseToolPayload(result);
        assert.equal(result.isError, true);
        assert.equal(readErrorCode(payload), "mutation_sql_required");
        assert.match(payload["instructions"] as string, /sql_query/u);
      }
    },
  );

  assert.deepEqual(calls.executedWorkspaceIds, []);
  assert.deepEqual(calls.workspaceDeadlines, []);
});

test("MCP SQL tools reject multi-statement input before either runner is called", async (): Promise<void> => {
  const calls = createCalls();
  await withClient(
    createConnection(["expenses:read", "expenses:write"]),
    createDependencies([PERSONAL_WORKSPACE_ID], calls),
    async (client): Promise<void> => {
      const query = await client.callTool({
        name: "sql_query",
        arguments: {
          sql: "SELECT account_id FROM accounts; SELECT amount FROM ledger_entries",
        },
      });
      assert.equal(query.isError, true);
      assert.equal(readErrorCode(parseToolPayload(query)), "single_statement_required");

      const execute = await client.callTool({
        name: "sql_execute",
        arguments: {
          sql: "INSERT INTO budget_lines (workspace_id) VALUES ('workspace-personal'); DELETE FROM budget_lines",
        },
      });
      assert.equal(execute.isError, true);
      assert.equal(readErrorCode(parseToolPayload(execute)), "single_statement_required");
    },
  );

  assert.deepEqual(calls.queriedWorkspaceIds, []);
  assert.deepEqual(calls.executedWorkspaceIds, []);
  assert.deepEqual(calls.workspaceDeadlines, []);
});
