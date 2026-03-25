import type OpenAI from "openai";
import { z } from "zod";
import { isExpenseSqlMutation } from "@expense-budget-tracker/agent-shared/sql-policy";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export type OpenAIToolContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

type ToolSuccessPayload = Readonly<Record<string, unknown>>;

type ToolErrorPayload = Readonly<{
  sql: string | null;
  error: Readonly<{
    name: string;
    message: string;
  }>;
}>;

export type ExecutedChatToolCall = Readonly<{
  output: string;
  isMutating: boolean;
  succeeded: boolean;
}>;

type QueryDatabaseToolInput = Readonly<{
  sql?: unknown;
}>;

const queryDatabaseInputSchema = z.object({
  sql: z.string(),
});

const createToolSuccessResult = (
  toolName: string,
  payload: ToolSuccessPayload,
): string =>
  JSON.stringify({
    ok: true,
    tool: toolName,
    ...payload,
  });

const createToolErrorResult = (
  toolName: string,
  payload: ToolErrorPayload,
): string =>
  JSON.stringify({
    ok: false,
    tool: toolName,
    ...payload,
  });

const serializeToolError = (
  error: unknown,
): Readonly<{
  name: string;
  message: string;
}> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
};

const getSqlFromRawArguments = (
  rawArguments: string,
): string | null => {
  try {
    const parsed = JSON.parse(rawArguments) as QueryDatabaseToolInput;
    return typeof parsed.sql === "string" ? parsed.sql : null;
  } catch {
    return null;
  }
};

const getIsMutatingSql = (
  sql: string | null,
): boolean => {
  if (sql === null) {
    return false;
  }

  try {
    return isExpenseSqlMutation(sql);
  } catch {
    return false;
  }
};

export const OPENAI_CHAT_TOOLS: ReadonlyArray<OpenAI.Responses.FunctionTool> = [{
  type: "function",
  name: "query_database",
  description: TOOL_DESCRIPTION,
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      sql: {
        type: "string",
        description: "SQL script to execute. One or more SELECT, WITH, INSERT, UPDATE, or DELETE statements separated by semicolons.",
      },
    },
    required: ["sql"],
  },
}];

export const executeChatToolCall = async (
  toolName: string,
  rawArguments: string,
  context: OpenAIToolContext,
): Promise<ExecutedChatToolCall> => {
  if (toolName !== "query_database") {
    throw new Error(`Unsupported OpenAI tool call: ${toolName}`);
  }

  const sql = getSqlFromRawArguments(rawArguments);
  const isMutating = getIsMutatingSql(sql);

  try {
    const parsed = queryDatabaseInputSchema.parse(JSON.parse(rawArguments));
    const result = await execQuery(parsed.sql, context.userId, context.workspaceId);
    return {
      output: createToolSuccessResult("query_database", {
        sql: parsed.sql,
        ...JSON.parse(result.json) as Readonly<Record<string, unknown>>,
      }),
      isMutating,
      succeeded: true,
    };
  } catch (error) {
    const payload: ToolErrorPayload = {
      sql,
      error: serializeToolError(error),
    };
    return {
      output: createToolErrorResult("query_database", payload),
      isMutating,
      succeeded: false,
    };
  }
};
