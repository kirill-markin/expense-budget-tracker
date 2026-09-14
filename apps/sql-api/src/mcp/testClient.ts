import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSqlExecutionDeadline,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AuthenticatedMcpAccessToken } from "./auth.js";
import {
  createMcpServerWithDependencies,
  type McpServerDependencies,
} from "./server.js";

// Single in-memory MCP client harness shared by the sql-api MCP tests, so transport
// wiring, the fixed test clock, and the close ordering cannot drift between them.
export const withMcpClient = async <T>(
  clientName: string,
  connection: AuthenticatedMcpAccessToken,
  dependencies: McpServerDependencies,
  callback: (client: Client) => Promise<T>,
): Promise<T> => {
  const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, () => 10_000);
  const server = createMcpServerWithDependencies(connection, deadline, dependencies);
  const client = new Client({ name: clientName, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
};
