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
  /**
   * Serialized tool output forwarded back into the OpenAI continuation input
   * and persisted in the local transcript.
   */
  output: string;
  /**
   * Canonical mutation flag derived from the exact SQL arguments executed for
   * this tool call. Runtime invalidation must use this value instead of
   * inferring mutability from earlier streamed tool snapshots.
   */
  isMutating: boolean;
  /**
   * Whether the tool execution itself succeeded. A completed transcript item is
   * not enough to refresh route-backed content; the runtime only invalidates
   * main content when a completed tool call both succeeded and mutated data.
   */
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

/**
 * Best-effort SQL extraction used to classify the executed tool call before we
 * know whether execution itself will succeed. Invalid JSON or invalid schema
 * simply means "not classifiable", which falls back to a non-mutating result.
 */
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

/**
 * Converts parsed SQL into the canonical mutation flag used by route
 * invalidation. Validation failures intentionally degrade to `false` so the
 * runtime never refreshes route content on uncertain metadata.
 */
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
  /**
   * This function is the canonical source of tool completion metadata consumed
   * by the chat runtime. Later layers may mark the transcript item as
   * `completed`, but route refresh is allowed only when this result reports
   * `succeeded === true` and `isMutating === true`.
   */
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
