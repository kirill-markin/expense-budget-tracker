import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createSqlExecutionDeadline,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { SqlTransactionOutcomeUnknownError } from "../dbDeadline.js";
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
  outputDataProperties: ReadonlyArray<string>;
  requiredOutputDataProperties: ReadonlyArray<string>;
  scopes: ReadonlyArray<"expenses:read" | "expenses:write">;
}>;

const EXPECTED_TOOL_DESCRIPTORS: ReadonlyArray<ExpectedToolDescriptor> = [
  {
    name: "list_workspaces",
    title: "List accessible workspaces",
    description: "Use this read-only discovery tool to list every workspace accessible to the authenticated user. It does not create or modify workspaces; pass a returned workspaceId to other tools when more than one is available.",
    inputProperties: [],
    requiredInputProperties: [],
    outputDataProperties: ["workspaces"],
    requiredOutputDataProperties: ["workspaces"],
    scopes: ["expenses:read"],
  },
  {
    name: "get_schema",
    title: "Inspect expense SQL schema",
    description: "Use this read-only discovery tool before writing SQL to inspect allowed relations, columns, constraints, and agent hints for an accessible workspace. It does not expose or query system catalogs.",
    inputProperties: ["workspaceId"],
    requiredInputProperties: [],
    outputDataProperties: ["limits", "relations", "workspace"],
    requiredOutputDataProperties: ["workspace", "relations", "limits"],
    scopes: ["expenses:read"],
  },
  {
    name: "sql_query",
    title: "Query expense data",
    description: "Use this read-only query tool to run exactly one policy-approved SELECT or WITH...SELECT statement against an accessible workspace. It executes in a repeatable-read, read-only transaction under the restricted SQL reader role.",
    inputProperties: ["sql", "workspaceId"],
    requiredInputProperties: ["sql"],
    outputDataProperties: ["limits", "statements", "workspace"],
    requiredOutputDataProperties: ["statements", "workspace", "limits"],
    scopes: ["expenses:read"],
  },
  {
    name: "sql_execute",
    title: "Execute expense data mutation",
    description: "Use this write-capable tool only for an approved expense-data mutation. It runs exactly one policy-approved INSERT, UPDATE, or DELETE statement under the restricted SQL executor role and may destructively modify workspace data.",
    inputProperties: ["sql", "workspaceId"],
    requiredInputProperties: ["sql"],
    outputDataProperties: ["limits", "statements", "workspace"],
    requiredOutputDataProperties: ["statements", "workspace", "limits"],
    scopes: ["expenses:read", "expenses:write"],
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
  assert.deepEqual(result.structuredContent, payload);
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

const assertToolSchemas = (
  tool: Tool,
  expected: ExpectedToolDescriptor,
): JsonObject => {
  const inputProperties = requireJsonObject(
    tool.inputSchema.properties ?? {},
    `Expected ${tool.name} input properties`,
  );
  assert.deepEqual(Object.keys(inputProperties).sort(), [...expected.inputProperties].sort());
  assert.deepEqual(tool.inputSchema.required ?? [], expected.requiredInputProperties);

  const outputSchema = requireJsonObject(
    tool.outputSchema,
    `Expected ${tool.name} output schema`,
  );
  assert.equal(outputSchema["type"], "object");
  assert.deepEqual(outputSchema["required"], ["ok", "data", "instructions"]);
  const outputProperties = requireJsonObject(
    outputSchema["properties"],
    `Expected ${tool.name} output properties`,
  );
  const okProperty = requireJsonObject(outputProperties["ok"], "Expected ok output property");
  const dataProperty = requireJsonObject(outputProperties["data"], "Expected data output property");
  const instructionsProperty = requireJsonObject(
    outputProperties["instructions"],
    "Expected instructions output property",
  );
  assert.equal(okProperty["type"], "boolean");
  assert.equal(okProperty["const"], true);
  assert.equal(dataProperty["type"], "object");
  const dataProperties = requireJsonObject(
    dataProperty["properties"],
    `Expected ${tool.name} data properties`,
  );
  assert.deepEqual(Object.keys(dataProperties).sort(), [...expected.outputDataProperties].sort());
  assert.deepEqual(dataProperty["required"], expected.requiredOutputDataProperties);
  assert.equal(instructionsProperty["type"], "string");
  assert.equal(instructionsProperty["minLength"], 1);
  return dataProperty;
};

const readSchemaProperties = (schema: JsonObject, message: string): JsonObject =>
  requireJsonObject(schema["properties"], message);

const readArrayItemSchema = (schema: JsonObject, message: string): JsonObject => {
  assert.equal(schema["type"], "array", message);
  return requireJsonObject(schema["items"], message);
};

const assertWorkspaceSchema = (schema: JsonObject): void => {
  assert.equal(schema["type"], "object");
  assert.deepEqual(schema["required"], ["workspaceId", "name"]);
  assert.deepEqual(Object.keys(readSchemaProperties(schema, "Expected workspace fields")).sort(), [
    "name",
    "workspaceId",
  ]);
};

const assertLimitsSchema = (schema: JsonObject): void => {
  assert.equal(schema["type"], "object");
  assert.deepEqual(schema["required"], ["maxRows", "statementTimeoutMs"]);
};

const readSqlCommandSchema = (dataSchema: JsonObject): JsonObject => {
  const dataProperties = readSchemaProperties(dataSchema, "Expected SQL data fields");
  const statementsSchema = requireJsonObject(
    dataProperties["statements"],
    "Expected SQL statements schema",
  );
  const statementSchema = readArrayItemSchema(statementsSchema, "Expected SQL statement items");
  assert.deepEqual(statementSchema["required"], [
    "sql",
    "command",
    "rows",
    "rowCount",
    "returnedRowCount",
    "totalRowCount",
    "truncated",
    "referencedRelations",
  ]);
  const statementProperties = readSchemaProperties(
    statementSchema,
    "Expected SQL statement fields",
  );
  const rowsSchema = requireJsonObject(statementProperties["rows"], "Expected SQL rows schema");
  const rowSchema = readArrayItemSchema(rowsSchema, "Expected SQL row items");
  const rowValueSchema = requireJsonObject(
    rowSchema["additionalProperties"],
    "Expected recursive JSON schema for SQL row values",
  );
  assert.notDeepEqual(rowValueSchema, {});

  const workspaceSchema = requireJsonObject(
    dataProperties["workspace"],
    "Expected SQL workspace schema",
  );
  const limitsSchema = requireJsonObject(dataProperties["limits"], "Expected SQL limits schema");
  assertWorkspaceSchema(workspaceSchema);
  assertLimitsSchema(limitsSchema);
  return requireJsonObject(statementProperties["command"], "Expected SQL command schema");
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

const withClient = async (
  connection: AuthenticatedMcpAccessToken,
  dependencies: McpServerDependencies,
  callback: (client: Client) => Promise<void>,
): Promise<void> => {
  const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, () => 10_000);
  const server = createMcpServerWithDependencies(connection, deadline, dependencies);
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
      const outputDataSchemas = new Map<string, JsonObject>();
      for (const expected of EXPECTED_TOOL_DESCRIPTORS) {
        const tool = requireTool(tools, expected.name);
        assert.equal(tool.title, expected.title);
        assert.equal(tool.description, expected.description);
        outputDataSchemas.set(tool.name, assertToolSchemas(tool, expected));
        assert.deepEqual(tool._meta, {
          securitySchemes: [{ type: "oauth2", scopes: expected.scopes }],
        });
        assert.equal(Object.prototype.hasOwnProperty.call(tool, "securitySchemes"), false);
      }

      const listDataSchema = requireJsonObject(
        outputDataSchemas.get("list_workspaces"),
        "Expected list_workspaces data schema",
      );
      const listDataProperties = readSchemaProperties(
        listDataSchema,
        "Expected list_workspaces data fields",
      );
      const workspacesSchema = requireJsonObject(
        listDataProperties["workspaces"],
        "Expected workspaces array schema",
      );
      assertWorkspaceSchema(readArrayItemSchema(
        workspacesSchema,
        "Expected workspace array items",
      ));

      const schemaDataSchema = requireJsonObject(
        outputDataSchemas.get("get_schema"),
        "Expected get_schema data schema",
      );
      const schemaDataProperties = readSchemaProperties(
        schemaDataSchema,
        "Expected get_schema data fields",
      );
      assertWorkspaceSchema(requireJsonObject(
        schemaDataProperties["workspace"],
        "Expected get_schema workspace schema",
      ));
      assertLimitsSchema(requireJsonObject(
        schemaDataProperties["limits"],
        "Expected get_schema limits schema",
      ));
      const relationsSchema = requireJsonObject(
        schemaDataProperties["relations"],
        "Expected relations array schema",
      );
      const relationSchema = readArrayItemSchema(relationsSchema, "Expected relation array items");
      assert.deepEqual(relationSchema["required"], ["name", "columns"]);
      const relationProperties = readSchemaProperties(
        relationSchema,
        "Expected relation fields",
      );
      const relationNameSchema = requireJsonObject(
        relationProperties["name"],
        "Expected relation name schema",
      );
      assert.deepEqual(relationNameSchema["enum"], [
        "ledger_entries",
        "accounts",
        "budget_lines",
        "workspace_settings",
        "account_metadata",
        "fx_rates_raw",
        "fx_rates_daily",
      ]);
      const columnsSchema = requireJsonObject(
        relationProperties["columns"],
        "Expected relation columns schema",
      );
      const columnSchema = readArrayItemSchema(columnsSchema, "Expected relation column items");
      assert.deepEqual(columnSchema["required"], [
        "name",
        "type",
        "nullable",
        "defaultValue",
      ]);
      const hintsSchema = requireJsonObject(
        relationProperties["hints"],
        "Expected relation hints schema",
      );
      assert.deepEqual(hintsSchema["required"], ["optional", "notes"]);

      const queryCommandSchema = readSqlCommandSchema(requireJsonObject(
        outputDataSchemas.get("sql_query"),
        "Expected sql_query data schema",
      ));
      assert.equal(queryCommandSchema["const"], "SELECT");
      const executeCommandSchema = readSqlCommandSchema(requireJsonObject(
        outputDataSchemas.get("sql_execute"),
        "Expected sql_execute data schema",
      ));
      assert.deepEqual(executeCommandSchema["enum"], ["INSERT", "UPDATE", "DELETE"]);

      for (const toolName of ["get_schema", "list_workspaces", "sql_query"]) {
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
        version: "1.2.1",
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
        "sql_query",
        "expenses:read",
        "sql_execute",
        "expenses:write",
        "https://api.expense-budget-tracker.com/v1/",
        "https://api.expense-budget-tracker.com/v1/openapi.json",
        "https://api.expense-budget-tracker.com/v1/swagger.json",
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
