/**
 * Transport-neutral agent tool result envelope. Every agent surface emits the
 * same payloads, so a model reads one contract whether it reached the workspace
 * over MCP or through the web chat.
 *
 * Distinct from the AgentEnvelope in ./index.ts, which carries the HTTP
 * discovery `actions` list instead of a tool result.
 */
import type { SqlPolicyError } from "./sql-policy.js";

export class AgentToolError extends Error {
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

export type AgentResultData = Readonly<Record<string, unknown>>;

export type AgentSuccessPayload<TData extends AgentResultData> = Readonly<{
  ok: true;
  data: TData;
  instructions: string;
}>;

export type AgentErrorPayload = Readonly<{
  ok: false;
  error: Readonly<{
    code: string;
    message: string;
    details?: AgentResultData;
  }>;
  instructions: string;
}>;

export type AgentResultPayload = AgentSuccessPayload<AgentResultData> | AgentErrorPayload;

// Serializes compactly on purpose: a tool result is read by programs and models,
// never rendered to a human, and indentation is not part of any tool-result
// contract. Pretty-printing spent roughly a third of every result's characters
// on whitespace.
export const serializeAgentPayload = (payload: AgentResultPayload): string => {
  const text = JSON.stringify(payload);
  if (text === undefined) {
    throw new Error("Agent result payload could not be serialized");
  }
  return text;
};

export const buildAgentSuccessPayload = <TData extends AgentResultData>(
  data: TData,
  instructions: string,
): AgentSuccessPayload<TData> => ({ ok: true, data, instructions });

export const buildAgentErrorPayload = (
  code: string,
  message: string,
  instructions: string,
  details: AgentResultData,
): AgentErrorPayload => ({
  ok: false,
  error: {
    code,
    message,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  },
  instructions,
});

// The default remedy only fits codes whose message names the offending SQL text.
// Codes fixed by reshaping the request instead get their own branch, because
// "fix the SQL" sends the caller back into the same failure.
export const getSqlPolicyInstructions = (error: SqlPolicyError, toolName: string): string => {
  if (error.code === "relation_not_allowed" || error.code === "invalid_relation_reference") {
    return `Call get_schema to inspect the allowed relations and columns, fix the SQL, then call ${toolName} again.`;
  }
  if (error.code === "read_only_sql_required") {
    return "Send reads to sql_query and approved INSERT, UPDATE, or DELETE statements to sql_execute.";
  }
  if (error.code === "mutation_sql_required") {
    return "Send SELECT and WITH...SELECT statements to sql_query. Call sql_execute only with an approved INSERT, UPDATE, or DELETE mutation.";
  }
  if (error.code === "single_statement_required") {
    return `Send one statement per call: split the script and call ${toolName} once for each statement.`;
  }
  if (error.code === "sql_script_too_long" || error.code === "too_many_sql_statements") {
    return `Split the work across several ${toolName} calls so every request stays inside the limit named in the error message.`;
  }
  if (
    error.code === "mutation_statement_row_limit_exceeded"
    || error.code === "mutation_request_row_limit_exceeded"
  ) {
    return `Narrow or split the mutation as directed by the error message, then call ${toolName} again.`;
  }
  if (error.code === "sql_result_too_large") {
    return `Dropping rows cannot clear this: the echoed statements are over the result budget on their own, so a lower LIMIT or an OFFSET page returns the same error. Send fewer statements per request, and shorten any statement whose own text is long, then call ${toolName} again.`;
  }
  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `Use sql_query to read this relation and write only to relations allowed by get_schema, then call ${toolName} again.`;
  }
  return `Fix the SQL using the policy error message, then call ${toolName} again.`;
};

export const getUnexpectedErrorInstructions = (toolName: string): string =>
  `Retry ${toolName} once. If it fails again, stop and report the server error.`;

export const getDeadlineInstructions = (toolName: string): string =>
  toolName === "sql_execute"
    ? "Retry sql_execute. The deadline expired before the mutation was dispatched, so no mutation was applied."
    : `Retry ${toolName}. This deadline failure is safe to retry because it cannot have applied a mutation.`;

export const getAmbiguousMutationInstructions = (): string =>
  "Do not blindly retry the mutation. Use sql_query to verify whether it applied, and retry sql_execute only if the change is confirmed absent.";
