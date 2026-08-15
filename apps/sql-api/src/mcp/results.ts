import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  SqlExecutionDeadlineError,
  SqlPolicyError,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { z } from "zod";
import { getSafeErrorType, log } from "../logger.js";
import {
  isAmbiguousSqlMutationOutcomeError,
  getUserSqlExecutionMessage,
  isUserSqlExecutionError,
} from "../machineApi/sqlService.js";

export class McpToolError extends Error {
  readonly code: string;
  readonly instructions: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    instructions: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.instructions = instructions;
    this.details = details;
  }
}

export type McpResultDependencies = Readonly<{
  log: typeof log;
}>;

const defaultDependencies: McpResultDependencies = { log };

export type McpJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<McpJsonValue>
  | McpJsonObject;

export type McpJsonObject = Readonly<{ [key: string]: McpJsonValue }>;

export type McpSuccessPayload<TData extends McpJsonObject> = Readonly<{
  ok: true;
  data: TData;
  instructions: string;
}>;

export const mcpJsonValueSchema: z.ZodType<McpJsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(mcpJsonValueSchema),
  z.record(z.string(), mcpJsonValueSchema),
]));

const successOkSchema = z.literal(true).describe(
  "Whether the tool call completed successfully.",
);
const successInstructionsSchema = z.string().min(1).describe(
  "Actionable guidance for using the returned data.",
);

export const buildMcpSuccessOutputSchema = <TDataSchema extends z.ZodObject>(
  dataSchema: TDataSchema,
) => z.object({
  ok: successOkSchema,
  data: dataSchema,
  instructions: successInstructionsSchema,
});

const isMcpJsonObject = (value: unknown): value is McpJsonObject =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && Object.values(value).every(isMcpJsonValue);

const isMcpJsonValue = (value: unknown): value is McpJsonValue => {
  if (
    typeof value === "string"
    || typeof value === "boolean"
    || value === null
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isMcpJsonValue);
  }
  return isMcpJsonObject(value);
};

const serializePayload = (payload: Readonly<Record<string, unknown>>): string => {
  const text = JSON.stringify(payload, null, 2);
  if (text === undefined) {
    throw new Error("MCP result payload could not be serialized");
  }
  return text;
};

const buildTextContent = (payload: Readonly<Record<string, unknown>>): CallToolResult["content"] => {
  return [{ type: "text", text: serializePayload(payload) }];
};

export const buildMcpSuccessResult = <TData extends Readonly<Record<string, unknown>>>(
  data: TData,
  instructions: string,
): CallToolResult => {
  const text = serializePayload({ ok: true, data, instructions });
  const payload: unknown = JSON.parse(text);
  if (!isMcpJsonObject(payload)) {
    throw new Error("MCP success result payload did not serialize to a JSON object");
  }
  return {
    structuredContent: payload,
    content: [{ type: "text", text }],
  };
};

const getSqlPolicyInstructions = (error: SqlPolicyError, toolName: string): string => {
  if (error.code === "relation_not_allowed" || error.code === "invalid_relation_reference") {
    return `Call get_schema to inspect the allowed relations and columns, fix the SQL, then call ${toolName} again.`;
  }
  if (error.code === "read_only_sql_required") {
    return "Send reads to sql_query and approved INSERT, UPDATE, or DELETE statements to sql_execute.";
  }
  if (error.code === "mutation_sql_required") {
    return "Send SELECT and WITH...SELECT statements to sql_query. Call sql_execute only with an approved INSERT, UPDATE, or DELETE mutation.";
  }
  if (
    error.code === "mutation_statement_row_limit_exceeded"
    || error.code === "mutation_request_row_limit_exceeded"
  ) {
    return `Narrow or split the mutation as directed by the error message, then call ${toolName} again.`;
  }
  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `Use sql_query to read this relation and write only to relations allowed by get_schema, then call ${toolName} again.`;
  }
  return `Fix the SQL using the policy error message, then call ${toolName} again.`;
};

const buildMcpErrorContent = (
  code: string,
  message: string,
  instructions: string,
  details: Readonly<Record<string, unknown>>,
): CallToolResult => ({
  isError: true,
  content: buildTextContent({
    ok: false,
    error: {
      code,
      message,
      ...(Object.keys(details).length === 0 ? {} : { details }),
    },
    instructions,
  }),
});

const getUnexpectedErrorInstructions = (toolName: string): string =>
  `Retry ${toolName} once. If it fails again, stop and report the server error.`;

const getDeadlineInstructions = (toolName: string): string =>
  toolName === "sql_execute"
    ? "Retry sql_execute. The deadline expired before the mutation was dispatched, so no mutation was applied."
    : `Retry ${toolName}. This deadline failure is safe to retry because it cannot have applied a mutation.`;

const getAmbiguousMutationInstructions = (): string =>
  "Do not blindly retry the mutation. Use sql_query to verify whether it applied, and retry sql_execute only if the change is confirmed absent.";

export const buildMcpToolErrorResultWithDependencies = (
  error: unknown,
  toolName: string,
  dependencies: McpResultDependencies,
): CallToolResult => {
  if (error instanceof McpToolError) {
    return buildMcpErrorContent(error.code, error.message, error.instructions, error.details);
  }

  if (error instanceof SqlPolicyError) {
    return buildMcpErrorContent(
      error.code,
      error.message,
      getSqlPolicyInstructions(error, toolName),
      {},
    );
  }

  if (error instanceof SqlExecutionDeadlineError) {
    return buildMcpErrorContent(
      "request_deadline_exceeded",
      `The MCP request exceeded its ${String(error.timeoutMs)} ms total execution deadline`,
      getDeadlineInstructions(toolName),
      { timeoutMs: error.timeoutMs, retryable: true },
    );
  }

  if (isAmbiguousSqlMutationOutcomeError(error)) {
    return buildMcpErrorContent(
      "sql_mutation_outcome_unknown",
      error.message,
      getAmbiguousMutationInstructions(),
      { outcome: "unknown", retryable: false },
    );
  }

  if (isUserSqlExecutionError(error)) {
    return buildMcpErrorContent(
      "sql_execution_failed",
      getUserSqlExecutionMessage(error),
      `Review SQL syntax, relation names, values, and constraints, then call ${toolName} again.`,
      {},
    );
  }

  dependencies.log({
    domain: "sql_api",
    action: "mcp_unexpected_error",
    boundary: "tool",
    operation: toolName,
    errorType: getSafeErrorType(error),
  });
  return buildMcpErrorContent(
    "internal_error",
    "The MCP tool request could not be completed",
    getUnexpectedErrorInstructions(toolName),
    {},
  );
};

export const buildMcpToolErrorResult = (
  error: unknown,
  toolName: string,
): CallToolResult => buildMcpToolErrorResultWithDependencies(error, toolName, defaultDependencies);
