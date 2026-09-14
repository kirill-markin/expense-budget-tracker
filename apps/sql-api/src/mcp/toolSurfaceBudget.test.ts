import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSqlExecutionDeadline,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import {
  createMcpServerWithDependencies,
  type McpServerDependencies,
} from "./server.js";

const WORKSPACE_ID = "workspace-personal";

const connection: AuthenticatedMcpAccessToken = {
  connectionId: "connection-1",
  clientId: "client-1",
  resource: "https://mcp.example.com/mcp",
  scopes: ["expenses:read", "expenses:write"],
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
};

const dependencies: McpServerDependencies = {
  listWorkspaces: async () => [{ workspaceId: WORKSPACE_ID, name: "Personal" }],
  getWorkspace: async () => ({ workspaceId: WORKSPACE_ID, name: "Personal" }),
  loadAllowedSchemaForWorkspace: async () => [{
    name: "ledger_entries",
    columns: [{ name: "amount", type: "numeric", nullable: false, defaultValue: null }],
  }],
  validateSingleReadOnlyExpenseSql,
  validateSingleMutationExpenseSql,
  runReadOnlySql: async (_authenticated, workspaceId, validated, deadline) => ({
    statements: [{
      sql: validated.sql,
      command: "SELECT",
      rows: [{ amount: "10.00" }],
      rowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 1,
      truncated: false,
      referencedRelations: ["ledger_entries"],
    }],
    workspace: { workspaceId, name: "Personal" },
    limits: { maxRows: 100, statementTimeoutMs: deadline.timeoutMs },
  }),
  runSql: async (_authenticated, workspaceId, validated, deadline) => ({
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
    limits: { maxRows: 100, statementTimeoutMs: deadline.timeoutMs },
  }),
};

const withClient = async (
  callback: (client: Client) => Promise<void>,
): Promise<void> => {
  const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, () => 10_000);
  const server = createMcpServerWithDependencies(connection, deadline, dependencies);
  const client = new Client({ name: "mcp-tool-surface-budget-test", version: "1.0.0" });
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

test("no MCP tool declares an output schema", async (): Promise<void> => {
  await withClient(async (client): Promise<void> => {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.equal(tool.outputSchema, undefined, `${tool.name} must not declare outputSchema`);
    }
  });
});

test("MCP results carry no structuredContent duplicate of the text block", async (): Promise<void> => {
  await withClient(async (client): Promise<void> => {
    const results = [
      await client.callTool({ name: "list_workspaces", arguments: {} }),
      await client.callTool({ name: "get_schema", arguments: {} }),
      await client.callTool({
        name: "sql_query",
        arguments: { sql: "SELECT amount FROM ledger_entries" },
      }),
      await client.callTool({
        name: "sql_execute",
        arguments: { sql: "DELETE FROM budget_lines WHERE category = 'Food'" },
      }),
    ];
    for (const result of results) {
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.ok(Array.isArray(result.content));
      assert.equal(result.content.length, 1);
    }
  });
});
