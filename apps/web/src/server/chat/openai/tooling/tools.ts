import type OpenAI from "openai";
import { z } from "zod";
import {
  AgentToolError,
  buildAgentErrorPayload,
  buildAgentSuccessPayload,
  getUnexpectedErrorInstructions,
  serializeAgentPayload,
  type AgentResultData,
} from "@expense-budget-tracker/agent-shared/agent-results";
import {
  AGENT_GUIDE_BY_TOPIC,
  AGENT_GUIDE_TOPICS,
  GET_GUIDE_TOOL,
  GET_SCHEMA_TOOL,
  getSchemaSuccessInstructions,
  getWorkspaceIdInputFieldDescription,
  getWorkspaceListSuccessInstructions,
  LIST_WORKSPACES_TOOL,
  type AgentSurfaceProfile,
  type AgentToolDefinition,
  type AgentToolInputField,
  type AgentToolName,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import { isExpenseSqlMutation } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  CHAT_SCHEMA_LIMITS,
  listChatWorkspaces,
  loadAllowedSchemaForChatWorkspace,
  resolveChatWorkspace,
} from "@/server/chat/dataService";
import { CHAT_SQL_TOOL_NAME, TOOL_DESCRIPTION, execQuery } from "@/server/chat/shared";
import { log } from "@/server/logger";

/**
 * How this surface narrows the shared catalog: the server pins every tool call
 * to the session's workspace, and one call carries a semicolon-separated script
 * for the single SQL tool registered here. All catalog instruction text is
 * rendered through this profile so a tool never names a tool this surface does
 * not register, and never advertises a workspaceId that execQuery would ignore.
 */
export const WEB_CHAT_SURFACE_PROFILE: AgentSurfaceProfile = {
  workspaceSelection: "server-fixed",
  statementMode: "script",
  sqlReadToolName: CHAT_SQL_TOOL_NAME,
  sqlWriteToolName: CHAT_SQL_TOOL_NAME,
};

/**
 * An unexpected discovery failure carries internal detail, such as a
 * WorkspaceAccessError or a raw Postgres message, and a discovery tool gives the
 * model nothing to repair with it. The model therefore sees a fixed string while
 * the real error goes to the logs, matching the MCP surface. query_database
 * deliberately keeps its raw message so the model can repair its own SQL.
 */
const DISCOVERY_INTERNAL_ERROR_MESSAGE = "The tool request could not be completed";

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

type ToolSuccessPayload = Readonly<Record<string, unknown>>;

export type ChatToolExecutionError = Readonly<{
  name: string;
  message: string;
}>;

type ToolErrorPayload = Readonly<{
  sql: string | null;
  error: ChatToolExecutionError;
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
   * Canonical mutation flag derived from the exact SQL arguments executed for
   * this tool call. Runtime invalidation must use this value instead of
   * inferring mutability from earlier streamed tool snapshots.
   */
  isMutating: boolean;
}> & ExecutedChatToolCallResult;

type QueryDatabaseToolInput = Readonly<{
  sql?: unknown;
}>;

const queryDatabaseInputSchema = z.object({
  sql: z.string(),
});

// Nullable because the strict tool schema renders an optional catalog field as
// a nullable one, so the model sends null for "use the current workspace".
const getSchemaInputSchema = z.object({
  workspaceId: z.string().trim().min(1).nullish(),
});

const getGuideInputSchema = z.object({
  topic: z.enum(AGENT_GUIDE_TOPICS),
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

const QUERY_DATABASE_TOOL: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: CHAT_SQL_TOOL_NAME,
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
};

/** The catalog tools this surface renders; the SQL tools stay chat-specific for now. */
const CHAT_DISCOVERY_TOOLS: ReadonlyArray<AgentToolDefinition> = [
  LIST_WORKSPACES_TOOL,
  GET_SCHEMA_TOOL,
  GET_GUIDE_TOOL,
];

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
 * profile, because the catalog's own wording invites a workspace switch that
 * only get_schema honours here.
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

export const OPENAI_CHAT_TOOLS: ReadonlyArray<OpenAI.Responses.FunctionTool> = [
  QUERY_DATABASE_TOOL,
  ...CHAT_DISCOVERY_TOOLS.map(buildOpenAIFunctionTool),
];

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
  succeeded: true,
  error: null,
});

const buildDiscoveryErrorResult = (
  error: unknown,
  toolName: AgentToolName,
  context: OpenAIToolContext,
  dependencies: ChatToolDependencies,
): ExecutedChatToolCall => {
  const serializedError = serializeToolError(error);
  if (!(error instanceof AgentToolError)) {
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
  }
  const payload = error instanceof AgentToolError
    ? buildAgentErrorPayload(error.code, error.message, error.instructions, error.details)
    : buildAgentErrorPayload(
      "internal_error",
      DISCOVERY_INTERNAL_ERROR_MESSAGE,
      getUnexpectedErrorInstructions(toolName),
      {},
    );
  return {
    output: serializeAgentPayload(payload),
    isMutating: false,
    succeeded: false,
    error: serializedError,
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
   * `succeeded === true` and `isMutating === true`.
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
  if (toolName !== CHAT_SQL_TOOL_NAME) {
    throw new Error(`Unsupported OpenAI tool call: ${toolName}`);
  }

  const sql = getSqlFromRawArguments(rawArguments);
  const isMutating = getIsMutatingSql(sql);

  try {
    const parsed = queryDatabaseInputSchema.parse(JSON.parse(rawArguments));
    const result = await dependencies.execQuery(parsed.sql, context);
    return {
      output: createToolSuccessResult(CHAT_SQL_TOOL_NAME, {
        sql: parsed.sql,
        ...JSON.parse(result.json) as Readonly<Record<string, unknown>>,
      }),
      isMutating,
      succeeded: true,
      error: null,
    };
  } catch (error) {
    const serializedError = serializeToolError(error);
    const payload: ToolErrorPayload = {
      sql,
      error: serializedError,
    };
    return {
      output: createToolErrorResult(CHAT_SQL_TOOL_NAME, payload),
      isMutating,
      succeeded: false,
      error: serializedError,
    };
  }
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
