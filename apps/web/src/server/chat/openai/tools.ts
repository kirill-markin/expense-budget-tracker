import { tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";

export type AgentContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

type ToolInvocationError = Readonly<{
  name?: unknown;
  message?: unknown;
  toolInvocation?: Readonly<{
    input?: unknown;
  }>;
}>;

const createToolSuccessResult = (
  toolName: string,
  payload: Readonly<Record<string, unknown>>,
): string =>
  JSON.stringify({
    ok: true,
    tool: toolName,
    ...payload,
  });

const createToolErrorResult = (
  toolName: string,
  payload: Readonly<Record<string, unknown>>,
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

const isInvalidToolInputError = (
  error: unknown,
): error is ToolInvocationError =>
  typeof error === "object"
  && error !== null
  && "name" in error
  && error.name === "InvalidToolInputError";

const createInvalidToolInputErrorFunction = (
  toolName: string,
  getPayload: (error: ToolInvocationError) => Readonly<Record<string, unknown>>,
): ((runContext: RunContext, error: unknown) => string) =>
  (_runContext: RunContext, error: unknown): string => {
    if (isInvalidToolInputError(error)) {
      return createToolErrorResult(toolName, getPayload(error));
    }

    return createToolErrorResult(toolName, {
      error: serializeToolError(error),
    });
  };

const createQueryDatabaseInvalidInputPayload = (): Readonly<Record<string, unknown>> => ({
  sql: null,
  error: {
    name: "InvalidToolInput",
    message: "query_database requires a string sql field",
  },
});

export const pgQueryTool = tool({
  name: "query_database",
  description: TOOL_DESCRIPTION,
  parameters: z.object({
    sql: z.string().describe("SQL script to execute. One or more SELECT, WITH, INSERT, UPDATE, or DELETE statements separated by semicolons."),
  }),
  errorFunction: createInvalidToolInputErrorFunction(
    "query_database",
    createQueryDatabaseInvalidInputPayload,
  ),
  execute: async (
    input: Readonly<{ sql: string }>,
    runContext?: RunContext<AgentContext>,
  ): Promise<string> => {
    if (runContext === undefined) {
      throw new Error("pgQueryTool: missing run context");
    }

    try {
      const { userId, workspaceId } = runContext.context;
      const result = await execQuery(input.sql, userId, workspaceId);
      return createToolSuccessResult("query_database", {
        sql: input.sql,
        ...JSON.parse(result.json) as Readonly<Record<string, unknown>>,
      });
    } catch (error) {
      return createToolErrorResult("query_database", {
        sql: input.sql,
        error: serializeToolError(error),
      });
    }
  },
});
