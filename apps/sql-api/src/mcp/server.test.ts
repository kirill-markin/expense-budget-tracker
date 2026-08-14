import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  validateSingleExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import {
  createMcpServerWithDependencies,
  type McpServerDependencies,
} from "./server.js";

const PERSONAL_WORKSPACE_ID = "workspace-personal";
const BUSINESS_WORKSPACE_ID = "workspace-business";

type ToolCalls = {
  listedUserIds: Array<string>;
  membershipWorkspaceIds: Array<string>;
  schemaWorkspaceIds: Array<string>;
  queriedWorkspaceIds: Array<string>;
  executedWorkspaceIds: Array<string>;
};

type JsonObject = Readonly<Record<string, unknown>>;

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
  listWorkspaces: async (identity) => {
    calls.listedUserIds.push(identity.userId);
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
  loadAllowedSchemaForWorkspace: async (_identity, workspaceId) => {
    calls.schemaWorkspaceIds.push(workspaceId);
    return [];
  },
  validateSingleReadOnlyExpenseSql,
  validateSingleExpenseSql,
  runReadOnlySql: async (_authenticated, workspaceId, validated) => {
    calls.queriedWorkspaceIds.push(workspaceId);
    return {
      statements: [{ sql: validated.sql, rows: [{ amount: "10.00" }] }],
      workspace: { workspaceId, name: "Personal" },
    };
  },
  runSql: async (_authenticated, workspaceId, validated) => {
    calls.executedWorkspaceIds.push(workspaceId);
    return {
      statements: [{ sql: validated.sql, command: "INSERT", rowCount: 1 }],
      workspace: { workspaceId, name: "Personal" },
    };
  },
});

const createCalls = (): ToolCalls => ({
  listedUserIds: [],
  membershipWorkspaceIds: [],
  schemaWorkspaceIds: [],
  queriedWorkspaceIds: [],
  executedWorkspaceIds: [],
});

const withClient = async (
  connection: AuthenticatedMcpAccessToken,
  dependencies: McpServerDependencies,
  callback: (client: Client) => Promise<void>,
): Promise<void> => {
  const server = createMcpServerWithDependencies(connection, dependencies);
  const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
};

test("MCP server registers four annotated tools and routes explicit workspaces", async (): Promise<void> => {
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
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "get_schema",
        "list_workspaces",
        "sql_execute",
        "sql_query",
      ]);
      for (const toolName of ["get_schema", "list_workspaces", "sql_query"]) {
        assert.deepEqual(tools.find((tool) => tool.name === toolName)?.annotations, {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      assert.deepEqual(tools.find((tool) => tool.name === "sql_execute")?.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });

      const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
      assert.equal(parseToolPayload(listed)["ok"], true);
      const schema = await client.callTool({
        name: "get_schema",
        arguments: { workspaceId: BUSINESS_WORKSPACE_ID },
      });
      assert.equal(parseToolPayload(schema)["ok"], true);
      const query = await client.callTool({
        name: "sql_query",
        arguments: {
          workspaceId: PERSONAL_WORKSPACE_ID,
          sql: "SELECT amount FROM ledger_entries",
        },
      });
      assert.equal(parseToolPayload(query)["ok"], true);
      const execute = await client.callTool({
        name: "sql_execute",
        arguments: {
          workspaceId: BUSINESS_WORKSPACE_ID,
          sql: "DELETE FROM budget_lines WHERE category = 'Food'",
        },
      });
      assert.equal(parseToolPayload(execute)["ok"], true);
    },
  );

  assert.deepEqual(calls.schemaWorkspaceIds, [BUSINESS_WORKSPACE_ID]);
  assert.deepEqual(calls.queriedWorkspaceIds, [PERSONAL_WORKSPACE_ID]);
  assert.deepEqual(calls.executedWorkspaceIds, [BUSINESS_WORKSPACE_ID]);
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
});
