import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export const TOOL_NAME = "query_database";

export const CODE_EXECUTION_TOOL: Anthropic.Beta.Messages.BetaCodeExecutionTool20250825 = {
  type: "code_execution_20250825",
  name: "code_execution",
};

export const DB_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      sql: {
        type: "string",
        description: "SQL statement to execute (SELECT, INSERT, UPDATE, DELETE)",
      },
    },
    required: ["sql"],
  },
};

export const executeTool = async (
  toolUseId: string,
  toolName: string,
  toolInput: unknown,
  userId: string,
  workspaceId: string,
): Promise<Anthropic.ToolResultBlockParam> => {
  if (toolName !== TOOL_NAME) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: `Unknown tool: ${toolName}`,
      is_error: true,
    };
  }

  const input = toolInput as { sql: string };

  try {
    const result = await execQuery(input.sql, userId, workspaceId);
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: result.json,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: message,
      is_error: true,
    };
  }
};
