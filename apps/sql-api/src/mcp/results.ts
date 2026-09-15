import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  SqlExecutionDeadlineError,
  SqlPolicyError,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  AgentToolError,
  buildAgentErrorPayload,
  buildAgentSuccessPayload,
  getAmbiguousMutationInstructions,
  getDeadlineInstructions,
  getSqlPolicyInstructions,
  getUnexpectedErrorInstructions,
  serializeAgentPayload,
  type AgentResultData,
  type AgentResultPayload,
} from "@expense-budget-tracker/agent-shared/agent-results";
import { getSafeErrorType, log, MAX_SQL_POLICY_LOG_MESSAGE_CHARS } from "../logger.js";
import {
  isAmbiguousSqlMutationOutcomeError,
  getUserSqlExecutionMessage,
  isUserSqlExecutionError,
} from "../machineApi/sqlService.js";

export { AgentToolError as McpToolError };

export type McpResultDependencies = Readonly<{
  log: typeof log;
}>;

const defaultDependencies: McpResultDependencies = { log };

const buildTextContent = (payload: AgentResultPayload): CallToolResult["content"] => {
  return [{ type: "text", text: serializeAgentPayload(payload) }];
};

export const buildMcpSuccessResult = <TData extends AgentResultData>(
  data: TData,
  instructions: string,
): CallToolResult => ({
  content: buildTextContent(buildAgentSuccessPayload(data, instructions)),
});

const buildMcpErrorContent = (
  code: string,
  message: string,
  instructions: string,
  details: AgentResultData,
): CallToolResult => ({
  isError: true,
  content: buildTextContent(buildAgentErrorPayload(code, message, instructions, details)),
});

export const buildMcpToolErrorResultWithDependencies = (
  error: unknown,
  toolName: string,
  dependencies: McpResultDependencies,
): CallToolResult => {
  if (error instanceof AgentToolError) {
    return buildMcpErrorContent(error.code, error.message, error.instructions, error.details);
  }

  if (error instanceof SqlPolicyError) {
    dependencies.log({
      domain: "sql_api",
      action: "sql_policy_rejected",
      code: error.code,
      message: error.message.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
    });
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
