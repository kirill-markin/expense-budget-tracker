import type OpenAI from "openai";
import { z } from "zod";
import {
  AgentToolError,
  buildAgentErrorPayload,
  buildAgentSuccessPayload,
  getAmbiguousMutationInstructions,
  getDeadlineInstructions,
  getSqlPolicyInstructions,
  getUnexpectedErrorInstructions,
  serializeAgentPayload,
  type AgentErrorPayload,
  type AgentResultData,
} from "@expense-budget-tracker/agent-shared/agent-results";
import {
  AGENT_GUIDE_BY_TOPIC,
  AGENT_GUIDE_TOPICS,
  AGENT_TOOLS,
  GET_GUIDE_TOOL,
  GET_SCHEMA_TOOL,
  getSchemaSuccessInstructions,
  getWorkspaceIdInputFieldDescription,
  getWorkspaceListSuccessInstructions,
  LIST_WORKSPACES_TOOL,
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
  type AgentSurfaceProfile,
  type AgentToolDefinition,
  type AgentToolInputField,
  type AgentToolName,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import {
  isExpenseSqlMutation,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
  type ValidatedExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  CHAT_SCHEMA_LIMITS,
  listChatWorkspaces,
  loadAllowedSchemaForChatWorkspace,
  resolveChatWorkspace,
} from "@/server/chat/dataService";
import {
  CHAT_SQL_STATEMENT_TIMEOUT_MESSAGE,
  ChatSqlMutationOutcomeUnknownError,
  execQuery,
  getChatSqlDeadlineMessage,
  getChatSqlPolicyMessage,
  isChatSqlStatementTimeoutError,
  isChatUserSqlExecutionError,
} from "@/server/chat/shared";
import {
  ChatSessionRunTransitionError,
  ChatTurnCancelledError,
} from "@/server/chat/store";
import { log, MAX_SQL_POLICY_LOG_MESSAGE_CHARS } from "@/server/logger";
import { WorkspaceAccessError } from "@/server/workspaceErrors";
import type { WorkspaceSummary } from "@/server/workspaces";

/**
 * How this surface narrows the shared catalog: it registers the catalog unchanged
 * and takes one statement per call, exactly like the MCP surface, and differs only
 * in the workspace default. A browser session always has a workspace open, so an
 * omitted workspaceId acts on that workspace instead of requiring the caller to
 * have exactly one accessible workspace.
 */
export const WEB_CHAT_SURFACE_PROFILE: AgentSurfaceProfile = {
  workspaceSelection: "session-default",
  statementMode: "single",
  sqlReadToolName: SQL_QUERY_TOOL.name,
  sqlWriteToolName: SQL_EXECUTE_TOOL.name,
};

/**
 * An unexpected failure carries internal detail, such as a WorkspaceAccessError
 * naming the user or a connection failure's raw Postgres text, and the model can
 * repair nothing with it. The model therefore sees a fixed string while the real
 * error goes to the logs, matching the MCP surface. Redaction is what every
 * unrecognized error gets; the single exception is a ChatUserSqlExecutionError,
 * raised only for a statement the database itself rejected.
 */
const CHAT_TOOL_INTERNAL_ERROR_MESSAGE = "The tool request could not be completed";

/**
 * Not advertised, and dispatchable only because stored transcripts replay this
 * name into the model. It resolves to the registered tool that now owns its
 * statement kind, so one policy path serves every SQL call and every result
 * names a tool this surface registers.
 */
const DEPRECATED_CHAT_SQL_TOOL_NAME = "query_database";

type ChatSqlToolName = typeof SQL_QUERY_TOOL.name | typeof SQL_EXECUTE_TOOL.name;

export type OpenAIToolContext = Readonly<{
  /** Primary CloudWatch correlation key: every chat error log must carry it. */
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}>;

type ChatToolDependencies = Readonly<{
  execQuery: typeof execQuery;
  listChatWorkspaces: typeof listChatWorkspaces;
  loadAllowedSchemaForChatWorkspace: typeof loadAllowedSchemaForChatWorkspace;
  log: typeof log;
}>;

const DEFAULT_CHAT_TOOL_DEPENDENCIES: ChatToolDependencies = {
  execQuery,
  listChatWorkspaces,
  loadAllowedSchemaForChatWorkspace,
  log,
};

export type ChatToolExecutionError = Readonly<{
  name: string;
  message: string;
}>;

/**
 * A completed transcript item refreshes route-backed content only when the
 * execution succeeded and mutated data. Failed executions retain their
 * structured error separately from the serialized model-facing output.
 */
type ExecutedChatToolCallResult =
  | Readonly<{
    succeeded: true;
    error: null;
  }>
  | Readonly<{
    succeeded: false;
    error: ChatToolExecutionError;
  }>;

export type ExecutedChatToolCall = Readonly<{
  /**
   * Serialized tool output forwarded back into the OpenAI continuation input
   * and persisted in the local transcript.
   */
  output: string;
  /**
   * Canonical mutation flag: true for the write tool alone, which is the only
   * one whose validator accepts a mutation. Runtime invalidation must use this
   * value instead of inferring mutability from earlier streamed tool snapshots.
   */
  isMutating: boolean;
  /**
   * Workspace the executed statement ran against, or null when the call
   * executed none. Route refresh also requires it to be the session's active
   * workspace, so a write to another accessible workspace never refreshes the
   * page the user is looking at.
   */
  workspaceId: string | null;
}> & ExecutedChatToolCallResult;

type SqlToolInput = Readonly<{
  sql?: unknown;
}>;

// Nullable because the strict tool schema renders an optional catalog field as
// a nullable one, so the model sends null for "use the current workspace".
const workspaceIdInputSchema = z.string().trim().min(1).nullish();

const sqlToolInputSchema = z.object({
  sql: z.string(),
  workspaceId: workspaceIdInputSchema,
});

const getSchemaInputSchema = z.object({
  workspaceId: workspaceIdInputSchema,
});

const getGuideInputSchema = z.object({
  topic: z.enum(AGENT_GUIDE_TOPICS),
});

const serializeToolError = (
  error: unknown,
): ChatToolExecutionError => {
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
 * Best-effort SQL extraction used to resolve the deprecated alias before its
 * arguments are validated. Invalid JSON or invalid schema simply means "not
 * classifiable", which falls back to the read tool.
 */
const getSqlFromRawArguments = (
  rawArguments: string,
): string | null => {
  try {
    const parsed = JSON.parse(rawArguments) as SqlToolInput;
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

/**
 * The tool that owns this call's statement kind. Only the deprecated alias needs
 * resolving, and a script it replays from an old transcript still classifies, so
 * the single-statement rejection that follows names the right replacement tool.
 */
const resolveChatSqlToolName = (
  toolName: string,
  rawArguments: string,
): ChatSqlToolName => {
  if (toolName === SQL_QUERY_TOOL.name) {
    return SQL_QUERY_TOOL.name;
  }
  if (toolName === SQL_EXECUTE_TOOL.name) {
    return SQL_EXECUTE_TOOL.name;
  }
  return getIsMutatingSql(getSqlFromRawArguments(rawArguments))
    ? SQL_EXECUTE_TOOL.name
    : SQL_QUERY_TOOL.name;
};

type OpenAIToolInputProperty = Readonly<{
  type: "string" | readonly ["string", "null"];
  description: string;
  enum?: ReadonlyArray<string>;
}>;

/**
 * A strict OpenAI function tool must list every property in `required`, so a
 * field that the catalog marks optional carries its optionality in a nullable
 * type instead. The enum is rendered from the guide topics because the catalog
 * describes each field without its value domain, and topic is the only field
 * whose values are a closed set. workspaceId is described through the surface
 * profile, because the catalog's own wording demands a workspaceId this surface
 * can resolve from the session instead.
 */
const buildToolInputProperty = (field: AgentToolInputField): OpenAIToolInputProperty => ({
  type: field.required ? "string" : ["string", "null"],
  description: field.name === "workspaceId"
    ? getWorkspaceIdInputFieldDescription(WEB_CHAT_SURFACE_PROFILE)
    : field.description,
  ...(field.name === "topic" ? { enum: [...AGENT_GUIDE_TOPICS] } : {}),
});

const buildOpenAIFunctionTool = (
  tool: AgentToolDefinition,
): OpenAI.Responses.FunctionTool => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      tool.inputFields.map((
        field,
      ): readonly [string, OpenAIToolInputProperty] => [field.name, buildToolInputProperty(field)]),
    ),
    required: tool.inputFields.map((field) => field.name),
  },
});

/** The whole shared catalog; the deprecated alias is deliberately not advertised. */
export const OPENAI_CHAT_TOOLS: ReadonlyArray<OpenAI.Responses.FunctionTool> =
  AGENT_TOOLS.map(buildOpenAIFunctionTool);

const buildInvalidToolArgumentsError = (
  toolName: AgentToolName,
  reason: string,
): AgentToolError => new AgentToolError(
  "invalid_tool_arguments",
  `The ${toolName} arguments do not match its input schema: ${reason}`,
  `Fix the arguments to match the ${toolName} input schema and call it again.`,
  {},
);

const parseToolArgumentsJson = (
  rawArguments: string,
  toolName: AgentToolName,
): unknown => {
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch (error) {
    throw buildInvalidToolArgumentsError(toolName, serializeToolError(error).message);
  }
};

const buildDiscoverySuccessResult = (
  data: AgentResultData,
  instructions: string,
): ExecutedChatToolCall => ({
  output: serializeAgentPayload(buildAgentSuccessPayload(data, instructions)),
  isMutating: false,
  workspaceId: null,
  succeeded: true,
  error: null,
});

const logUnexpectedChatToolError = (
  serializedError: ChatToolExecutionError,
  toolName: AgentToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): void => {
  dependencies.log({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Chat tool ${toolName} failed: ${serializedError.name}: ${serializedError.message}`,
    requestId: context.requestId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
  });
};

const buildRedactedErrorPayload = (
  error: unknown,
  toolName: AgentToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): AgentErrorPayload => {
  if (error instanceof WorkspaceAccessError) {
    dependencies.log({
      domain: "chat",
      action: "workspace_unavailable",
      vendor: "openai",
      stage: "agent",
      error: error.message,
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
    });
  } else {
    logUnexpectedChatToolError(serializeToolError(error), toolName, context, dependencies);
  }
  return buildAgentErrorPayload(
    "internal_error",
    CHAT_TOOL_INTERNAL_ERROR_MESSAGE,
    getUnexpectedErrorInstructions(toolName),
    {},
  );
};

const buildDiscoveryErrorResult = (
  error: unknown,
  toolName: AgentToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): ExecutedChatToolCall => {
  const payload = error instanceof AgentToolError
    ? buildAgentErrorPayload(error.code, error.message, error.instructions, error.details)
    : buildRedactedErrorPayload(error, toolName, context, dependencies);
  return {
    output: serializeAgentPayload(payload),
    isMutating: false,
    workspaceId: null,
    succeeded: false,
    error: serializeToolError(error),
  };
};

const executeListWorkspacesToolCall = async (
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): Promise<ExecutedChatToolCall> => {
  try {
    const workspaces = await dependencies.listChatWorkspaces(context);
    // The catalog's static successInstructions covers the multi-workspace branch
    // of another surface only, so the emitted text comes from the returned row
    // count rendered through this surface's profile.
    return buildDiscoverySuccessResult(
      { workspaces },
      getWorkspaceListSuccessInstructions(workspaces.length, WEB_CHAT_SURFACE_PROFILE),
    );
  } catch (error) {
    return buildDiscoveryErrorResult(error, LIST_WORKSPACES_TOOL.name, context, dependencies);
  }
};

const executeGetSchemaToolCall = async (
  rawArguments: string,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): Promise<ExecutedChatToolCall> => {
  try {
    const input = getSchemaInputSchema.safeParse(
      parseToolArgumentsJson(rawArguments, GET_SCHEMA_TOOL.name),
    );
    if (!input.success) {
      throw buildInvalidToolArgumentsError(GET_SCHEMA_TOOL.name, input.error.message);
    }
    const workspaces = await dependencies.listChatWorkspaces(context);
    const workspace = resolveChatWorkspace(
      workspaces,
      input.data.workspaceId ?? undefined,
      context.workspaceId,
    );
    const relations = await dependencies.loadAllowedSchemaForChatWorkspace(
      context,
      workspace.workspaceId,
    );
    return buildDiscoverySuccessResult(
      { workspace, relations, limits: CHAT_SCHEMA_LIMITS },
      getSchemaSuccessInstructions(WEB_CHAT_SURFACE_PROFILE),
    );
  } catch (error) {
    return buildDiscoveryErrorResult(error, GET_SCHEMA_TOOL.name, context, dependencies);
  }
};

const executeGetGuideToolCall = (
  rawArguments: string,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): ExecutedChatToolCall => {
  try {
    const input = getGuideInputSchema.safeParse(
      parseToolArgumentsJson(rawArguments, GET_GUIDE_TOOL.name),
    );
    if (!input.success) {
      throw buildInvalidToolArgumentsError(GET_GUIDE_TOOL.name, input.error.message);
    }
    return buildDiscoverySuccessResult(
      { topic: input.data.topic, guide: AGENT_GUIDE_BY_TOPIC[input.data.topic] },
      GET_GUIDE_TOOL.successInstructions,
    );
  } catch (error) {
    return buildDiscoveryErrorResult(error, GET_GUIDE_TOOL.name, context, dependencies);
  }
};

type PreparedSqlToolCall = Readonly<{
  validated: ValidatedExpenseSql;
  workspace: WorkspaceSummary;
}>;

/**
 * Everything settled before the statement runs. The statement is validated
 * before the workspace is resolved, the way apps/sql-api/src/mcp/server.ts
 * orders the same pair, so a rejected statement never reaches the database.
 */
const prepareSqlToolCall = async (
  toolName: ChatSqlToolName,
  rawArguments: string,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): Promise<PreparedSqlToolCall> => {
  const input = sqlToolInputSchema.safeParse(
    parseToolArgumentsJson(rawArguments, toolName),
  );
  if (!input.success) {
    throw buildInvalidToolArgumentsError(toolName, input.error.message);
  }
  const validated = toolName === SQL_EXECUTE_TOOL.name
    ? validateSingleMutationExpenseSql(input.data.sql)
    : validateSingleReadOnlyExpenseSql(input.data.sql);
  const workspaces = await dependencies.listChatWorkspaces(context);
  return {
    validated,
    workspace: resolveChatWorkspace(
      workspaces,
      input.data.workspaceId ?? undefined,
      context.workspaceId,
    ),
  };
};

/**
 * The single point where a restricted SQL policy rejection becomes a chat tool
 * result, so one call here is one rejection. The raw policy message is logged
 * rather than the chat-specific rewrite, which keeps the recorded reason equal
 * to the one the machine API and MCP surfaces record.
 */
const buildSqlPolicyErrorPayload = (
  error: SqlPolicyError,
  toolName: ChatSqlToolName,
  dependencies: ChatToolDependencies,
): AgentErrorPayload => {
  dependencies.log({
    domain: "sql-api",
    action: "sql_policy_rejected",
    code: error.code,
    message: error.message.slice(0, MAX_SQL_POLICY_LOG_MESSAGE_CHARS),
  });
  return buildAgentErrorPayload(
    error.code,
    getChatSqlPolicyMessage(error),
    getSqlPolicyInstructions(error, toolName),
    {},
  );
};

/**
 * Preparation can fail on the arguments, on the statement, or on the workspace
 * lookup. Only the first two produce something the model can act on; a workspace
 * lookup that fails any other way carries internal detail, such as a
 * WorkspaceAccessError or a raw Postgres message, so it is redacted and logged
 * exactly like a discovery failure.
 */
const buildSqlPreparationErrorPayload = (
  error: unknown,
  toolName: ChatSqlToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): AgentErrorPayload => {
  if (error instanceof AgentToolError) {
    return buildAgentErrorPayload(error.code, error.message, error.instructions, error.details);
  }
  if (error instanceof SqlPolicyError) {
    return buildSqlPolicyErrorPayload(error, toolName, dependencies);
  }
  return buildRedactedErrorPayload(error, toolName, context, dependencies);
};

/**
 * An execution failure stays in the shared envelope the MCP surface emits, and
 * branches the way apps/sql-api/src/mcp/results.ts does, so one contract
 * describes every tool result. Redaction is the default, exactly as it is there:
 * the raw message and the invitation to try again are reached only through the
 * positive ChatUserSqlExecutionError check, which the executor raises for a
 * statement the database itself rejected and for nothing else.
 */
const buildSqlExecutionErrorPayload = (
  error: unknown,
  toolName: ChatSqlToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): AgentErrorPayload => {
  if (error instanceof AgentToolError) {
    return buildAgentErrorPayload(error.code, error.message, error.instructions, error.details);
  }
  if (error instanceof SqlPolicyError) {
    return buildSqlPolicyErrorPayload(error, toolName, dependencies);
  }
  if (error instanceof SqlExecutionDeadlineError) {
    return buildAgentErrorPayload(
      "request_deadline_exceeded",
      getChatSqlDeadlineMessage(error),
      getDeadlineInstructions(toolName),
      { timeoutMs: error.timeoutMs, retryable: true },
    );
  }
  // The deadline above is only checked between database commands, so a single
  // statement that outlives it is instead cancelled by the per-command
  // statement_timeout set from the budget still left. That is the ordinary
  // shape of a slow statement here, and it is the same answer the MCP surface
  // reaches through its client-side backstop. PostgreSQL blamed the statement
  // for being too slow rather than for being wrong, so the model is asked for
  // less work per call, not for a rewrite. The cancellation aborts the
  // transaction on either tool, so nothing was applied and a retry is safe.
  if (isChatSqlStatementTimeoutError(error)) {
    return buildAgentErrorPayload(
      "request_deadline_exceeded",
      CHAT_SQL_STATEMENT_TIMEOUT_MESSAGE,
      getDeadlineInstructions(toolName),
      { timeoutMs: MCP_SQL_STATEMENT_TIMEOUT_MS, retryable: true },
    );
  }
  // Raised by the mutation turn lock this call runs inside: the user stopped
  // this turn, or the session moved on to another run. Repeating the call would
  // be refused again at best and write twice at worst.
  if (
    error instanceof ChatTurnCancelledError
    || error instanceof ChatSessionRunTransitionError
  ) {
    return buildAgentErrorPayload(
      "chat_turn_not_active",
      "This chat turn is no longer the session's active turn, so the call was abandoned",
      `Stop this task and do not call ${toolName} again for this turn.`,
      { retryable: false },
    );
  }
  if (error instanceof ChatSqlMutationOutcomeUnknownError) {
    return buildAgentErrorPayload(
      "sql_mutation_outcome_unknown",
      "The SQL mutation transaction outcome is unknown",
      getAmbiguousMutationInstructions(),
      { outcome: "unknown", retryable: false },
    );
  }
  // Raised at the one call site that runs the model's own statement, and only
  // when PostgreSQL blamed that statement. Everything else this call touches —
  // provisioning, whose message names the user; a pool connection carrying raw
  // Postgres text; a transaction outcome lost before any mutating statement was
  // issued, which is every lost outcome on a read; the shared executor's
  // own invariants — falls through to the redacted default below, because none
  // of it is repaired by rewriting SQL.
  if (isChatUserSqlExecutionError(error)) {
    return buildAgentErrorPayload(
      "sql_execution_failed",
      error.message,
      `Review SQL syntax, relation names, values, and constraints, then call ${toolName} again.`,
      {},
    );
  }
  return buildRedactedErrorPayload(error, toolName, context, dependencies);
};

/**
 * A failed SQL call never refreshes route-backed content. The refresh gate also
 * requires `succeeded`, so the null workspace keeps even an ambiguous mutation
 * from reloading the page on an outcome nobody has verified yet.
 */
const buildFailedSqlToolCall = (
  error: unknown,
  isMutating: boolean,
  payload: AgentErrorPayload,
): ExecutedChatToolCall => ({
  output: serializeAgentPayload(payload),
  isMutating,
  workspaceId: null,
  succeeded: false,
  error: serializeToolError(error),
});

const executeSqlToolCall = async (
  toolName: ChatSqlToolName,
  rawArguments: string,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): Promise<ExecutedChatToolCall> => {
  const isMutating = toolName === SQL_EXECUTE_TOOL.name;

  let prepared: PreparedSqlToolCall;
  try {
    prepared = await prepareSqlToolCall(toolName, rawArguments, context, dependencies);
  } catch (error) {
    return buildFailedSqlToolCall(
      error,
      isMutating,
      buildSqlPreparationErrorPayload(error, toolName, context, dependencies),
    );
  }

  try {
    // The context keeps naming the browser session's workspace, which scopes the
    // chat session row the mutation turn lock reads; the statement itself runs
    // against the resolved workspace carried beside it.
    const result = await dependencies.execQuery(prepared.validated, context, {
      workspace: prepared.workspace,
      instructions: isMutating
        ? SQL_EXECUTE_TOOL.successInstructions
        : SQL_QUERY_TOOL.successInstructions,
    });
    return {
      output: result.json,
      isMutating,
      workspaceId: prepared.workspace.workspaceId,
      succeeded: true,
      error: null,
    };
  } catch (error) {
    return buildFailedSqlToolCall(
      error,
      isMutating,
      buildSqlExecutionErrorPayload(error, toolName, context, dependencies),
    );
  }
};

export const executeChatToolCallWithDependencies = async (
  toolName: string,
  rawArguments: string,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): Promise<ExecutedChatToolCall> => {
  /**
   * This function is the canonical source of tool completion metadata consumed
   * by the chat runtime. Later layers may mark the transcript item as
   * `completed`, but route refresh is allowed only when this result reports
   * `succeeded === true`, `isMutating === true`, and a `workspaceId` equal to
   * the session's active workspace.
   */
  if (toolName === LIST_WORKSPACES_TOOL.name) {
    return executeListWorkspacesToolCall(context, dependencies);
  }
  if (toolName === GET_SCHEMA_TOOL.name) {
    return executeGetSchemaToolCall(rawArguments, context, dependencies);
  }
  if (toolName === GET_GUIDE_TOOL.name) {
    return executeGetGuideToolCall(rawArguments, context, dependencies);
  }
  if (
    toolName === SQL_QUERY_TOOL.name
    || toolName === SQL_EXECUTE_TOOL.name
    || toolName === DEPRECATED_CHAT_SQL_TOOL_NAME
  ) {
    return executeSqlToolCall(
      resolveChatSqlToolName(toolName, rawArguments),
      rawArguments,
      context,
      dependencies,
    );
  }

  throw new Error(`Unsupported OpenAI tool call: ${toolName}`);
};

export const executeChatToolCall = async (
  toolName: string,
  rawArguments: string,
  context: OpenAIToolContext,
): Promise<ExecutedChatToolCall> =>
  executeChatToolCallWithDependencies(
    toolName,
    rawArguments,
    context,
    DEFAULT_CHAT_TOOL_DEPENDENCIES,
  );
