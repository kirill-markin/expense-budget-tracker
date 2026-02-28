import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

type McpServer = ReturnType<typeof createSdkMcpServer>;

export const MCP_SERVER_NAME = "expense-tracker-db";
export const MCP_TOOL_NAME = "query_database";
export const QUALIFIED_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`;

export const createDbMcpServer = (
  userId: string,
  workspaceId: string,
): McpServer =>
  createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        MCP_TOOL_NAME,
        TOOL_DESCRIPTION,
        {
          sql: z.string().describe("SQL statement to execute (SELECT, INSERT, UPDATE, DELETE)"),
        },
        async (args: { sql: string }) => {
          try {
            const result = await execQuery(args.sql, userId, workspaceId);
            return { content: [{ type: "text" as const, text: result.json }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              isError: true,
              content: [{ type: "text" as const, text: message }],
            };
          }
        },
      ),
    ],
  });
