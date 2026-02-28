import { tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export type AgentContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export const pgQueryTool = tool({
  name: "query_database",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    sql: z.string().describe("SQL statement to execute (SELECT, INSERT, UPDATE, DELETE)"),
  }),
  execute: async (
    input: { sql: string },
    runContext?: RunContext<AgentContext>,
  ): Promise<string> => {
    if (runContext === undefined) {
      throw new Error("pgQueryTool: missing run context");
    }

    const { userId, workspaceId } = runContext.context;
    const result = await execQuery(input.sql, userId, workspaceId);
    return result.json;
  },
});
