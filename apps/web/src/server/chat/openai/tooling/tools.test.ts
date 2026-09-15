import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_GUIDE_BY_TOPIC,
  AGENT_GUIDE_TOPICS,
  AGENT_TOOLS,
  GET_GUIDE_TOOL,
  GET_SCHEMA_TOOL,
  getSchemaSuccessInstructions,
  getWorkspaceListSuccessInstructions,
  LIST_WORKSPACES_TOOL,
  type AgentToolDefinition,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import type { SchemaRelation } from "@/server/agent/schema";
import { CHAT_SCHEMA_LIMITS, type ChatWorkspaceContext } from "@/server/chat/dataService";
import type { ChatSqlExecutionContext } from "@/server/chat/shared";
import type { WorkspaceSummary } from "@/server/workspaces";
import {
  executeChatToolCallWithDependencies,
  OPENAI_CHAT_TOOLS,
  WEB_CHAT_SURFACE_PROFILE,
  type OpenAIToolContext,
} from "./tools";

const CONTEXT: OpenAIToolContext = {
  requestId: "request-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
};

const WORKSPACES: ReadonlyArray<WorkspaceSummary> = [
  { workspaceId: "workspace-1", name: "Personal" },
  { workspaceId: "workspace-2", name: "Business" },
];

const RELATIONS: ReadonlyArray<SchemaRelation> = [{
  name: "ledger_entries",
  columns: [{ name: "entry_id", type: "text", nullable: false, defaultValue: null }],
}];

const CATALOG_DISCOVERY_TOOLS: ReadonlyArray<AgentToolDefinition> = [
  LIST_WORKSPACES_TOOL,
  GET_SCHEMA_TOOL,
  GET_GUIDE_TOOL,
];

const unusedExecQuery = async (): Promise<never> => {
  throw new Error("execQuery must not be called by a discovery tool");
};

const unusedListChatWorkspaces = async (): Promise<never> => {
  throw new Error("listChatWorkspaces must not be called by this tool");
};

const unusedLoadAllowedSchemaForChatWorkspace = async (): Promise<never> => {
  throw new Error("loadAllowedSchemaForChatWorkspace must not be called by this tool");
};

/** Only an unexpected failure may log, so every other path proves it stays silent. */
const unexpectedLog = (event: unknown): never => {
  throw new Error(`A chat tool logged an unexpected error: ${JSON.stringify(event)}`);
};

/** Catalog tools this surface does not register, and therefore must never name. */
const UNREGISTERED_CATALOG_TOOL_NAMES: ReadonlyArray<string> = AGENT_TOOLS
  .map((tool) => tool.name)
  .filter((name) => !OPENAI_CHAT_TOOLS.some((rendered) => rendered.name === name));

type DiscoveryPayload = Readonly<{
  ok: boolean;
  data?: Readonly<Record<string, unknown>>;
  error?: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }>;
  instructions: string;
}>;

const parseDiscoveryPayload = (output: string): DiscoveryPayload =>
  JSON.parse(output) as DiscoveryPayload;

type RenderedToolParameters = Readonly<{
  type: string;
  additionalProperties: boolean;
  properties: Readonly<Record<string, Readonly<{
    type: string | ReadonlyArray<string>;
    enum?: ReadonlyArray<string>;
  }>>>;
  required: ReadonlyArray<string>;
}>;

const getRenderedToolParameters = (toolName: string): RenderedToolParameters => {
  const rendered = OPENAI_CHAT_TOOLS.find((candidate) => candidate.name === toolName);
  if (rendered === undefined || rendered.parameters === null) {
    throw new Error(`Tool ${toolName} is not registered with parameters for the web chat`);
  }
  return rendered.parameters as unknown as RenderedToolParameters;
};

test("query_database forwards the exact session and turn scope to SQL execution", async (): Promise<void> => {
  const context: OpenAIToolContext = {
    requestId: "request-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  let receivedContext: ChatSqlExecutionContext | null = null;

  const result = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql: "SELECT account_id FROM accounts" }),
    context,
    {
      execQuery: async (_sql, executionContext) => {
        receivedContext = executionContext;
        return {
          json: JSON.stringify({ statements: [] }),
        };
      },
      log: unexpectedLog,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.error, null);
  assert.equal(result.isMutating, false);
  assert.deepEqual(receivedContext, context);
});

test("query_database exposes the same structured error returned to OpenAI", async (): Promise<void> => {
  const sql = "SELECT account_id FROM missing_accounts";
  const result = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql }),
    {
      requestId: "request-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      execQuery: async (): Promise<never> => {
        throw new RangeError("relation missing_accounts does not exist");
      },
      log: unexpectedLog,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.isMutating, false);
  assert.deepEqual(result.error, {
    name: "RangeError",
    message: "relation missing_accounts does not exist",
  });
  assert.deepEqual(JSON.parse(result.output), {
    ok: false,
    tool: "query_database",
    sql,
    error: result.error,
  });
});

test("list_workspaces returns every accessible workspace without touching SQL", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "list_workspaces",
    JSON.stringify({}),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: async () => WORKSPACES,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.isMutating, false);
  assert.deepEqual(parseDiscoveryPayload(result.output), {
    ok: true,
    data: { workspaces: WORKSPACES },
    instructions: getWorkspaceListSuccessInstructions(WORKSPACES.length, WEB_CHAT_SURFACE_PROFILE),
  });
});

test("list_workspaces instructions come from this surface's profile, not the static catalog field", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "list_workspaces",
    JSON.stringify({}),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: async () => [WORKSPACES[0]],
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  const payload = parseDiscoveryPayload(result.output);
  assert.equal(payload.instructions, getWorkspaceListSuccessInstructions(1, WEB_CHAT_SURFACE_PROFILE));
  assert.notEqual(payload.instructions, LIST_WORKSPACES_TOOL.successInstructions);
});

test("get_schema falls back to the session workspace when workspaceId is omitted", async (): Promise<void> => {
  const requestedWorkspaceIds: Array<string> = [];
  const dependencies = {
    execQuery: unusedExecQuery,
    log: unexpectedLog,
    listChatWorkspaces: async (): Promise<ReadonlyArray<WorkspaceSummary>> => WORKSPACES,
    loadAllowedSchemaForChatWorkspace: async (
      _context: ChatWorkspaceContext,
      workspaceId: string,
    ): Promise<ReadonlyArray<SchemaRelation>> => {
      requestedWorkspaceIds.push(workspaceId);
      return RELATIONS;
    },
  };

  const omitted = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({}),
    CONTEXT,
    dependencies,
  );
  const nulled = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({ workspaceId: null }),
    CONTEXT,
    dependencies,
  );

  assert.equal(omitted.succeeded, true);
  assert.equal(nulled.succeeded, true);
  assert.deepEqual(requestedWorkspaceIds, ["workspace-1", "workspace-1"]);
  assert.deepEqual(parseDiscoveryPayload(omitted.output), {
    ok: true,
    data: {
      workspace: { workspaceId: "workspace-1", name: "Personal" },
      relations: RELATIONS,
      limits: CHAT_SCHEMA_LIMITS,
    },
    instructions: getSchemaSuccessInstructions(WEB_CHAT_SURFACE_PROFILE),
  });
});

test("get_schema accepts an explicit workspaceId the caller is a member of", async (): Promise<void> => {
  let requestedWorkspaceId: string | null = null;

  const result = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({ workspaceId: "workspace-2" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: async () => WORKSPACES,
      loadAllowedSchemaForChatWorkspace: async (_context, workspaceId) => {
        requestedWorkspaceId = workspaceId;
        return RELATIONS;
      },
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(requestedWorkspaceId, "workspace-2");
  assert.deepEqual(
    parseDiscoveryPayload(result.output).data?.workspace,
    { workspaceId: "workspace-2", name: "Business" },
  );
});

test("get_schema rejects a workspaceId outside the caller's workspaces before reading it", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({ workspaceId: "workspace-9" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: async () => WORKSPACES,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  const payload = parseDiscoveryPayload(result.output);
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, "workspace_not_found");
  assert.deepEqual(payload.error?.details, { workspaceId: "workspace-9" });
});

test("get_guide returns the shared guide for every catalog topic", async (): Promise<void> => {
  for (const topic of AGENT_GUIDE_TOPICS) {
    const result = await executeChatToolCallWithDependencies(
      "get_guide",
      JSON.stringify({ topic }),
      CONTEXT,
      {
        execQuery: unusedExecQuery,
        log: unexpectedLog,
        listChatWorkspaces: unusedListChatWorkspaces,
        loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      },
    );

    assert.equal(result.succeeded, true);
    assert.deepEqual(parseDiscoveryPayload(result.output), {
      ok: true,
      data: { topic, guide: AGENT_GUIDE_BY_TOPIC[topic] },
      instructions: GET_GUIDE_TOOL.successInstructions,
    });
  }
});

test("get_guide rejects a topic outside the catalog", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "get_guide",
    JSON.stringify({ topic: "unknown_topic" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(parseDiscoveryPayload(result.output).error?.code, "invalid_tool_arguments");
});

/**
 * The catalog's `required` flags and the rendered schema are two independent
 * declarations of the same contract, and the MCP surface derives its own from
 * zod. A strict OpenAI tool lists every property in `required`, so the rendered
 * required-ness lives in which properties are non-nullable.
 */
test("the rendered discovery tool schemas match the catalog's required flags", (): void => {
  for (const tool of CATALOG_DISCOVERY_TOOLS) {
    const parameters = getRenderedToolParameters(tool.name);
    const fieldNames = tool.inputFields.map((field) => field.name);

    assert.deepEqual(Object.keys(parameters.properties), fieldNames);
    assert.deepEqual([...parameters.required], fieldNames);
    assert.deepEqual(
      Object.entries(parameters.properties)
        .filter(([, property]) => typeof property.type === "string")
        .map(([name]) => name),
      tool.inputFields.filter((field) => field.required).map((field) => field.name),
    );
  }
});

test("get_guide renders the catalog guide topics as its topic enum", (): void => {
  const topicProperty = getRenderedToolParameters(GET_GUIDE_TOOL.name).properties.topic;
  assert.deepEqual(topicProperty.enum, [...AGENT_GUIDE_TOPICS]);
});

/**
 * The registered tool list and the dispatcher's name checks are two independent
 * lists. An advertised name with no dispatch path reaches the
 * `Unsupported OpenAI tool call` throw, and the dispatch loop does not catch it,
 * so the whole chat turn aborts.
 */
test("every registered tool name has a dispatch path", async (): Promise<void> => {
  // One argument object serving every registered tool: unknown properties are
  // ignored, so a tool later added to this surface is covered without changes.
  const rawArguments = JSON.stringify({
    sql: "SELECT account_id FROM accounts",
    topic: AGENT_GUIDE_TOPICS[0],
    workspaceId: null,
  });

  for (const tool of OPENAI_CHAT_TOOLS) {
    const result = await executeChatToolCallWithDependencies(
      tool.name,
      rawArguments,
      CONTEXT,
      {
        execQuery: async () => ({ json: JSON.stringify({ statements: [] }) }),
        listChatWorkspaces: async () => WORKSPACES,
        loadAllowedSchemaForChatWorkspace: async () => RELATIONS,
        log: unexpectedLog,
      },
    );

    assert.equal(result.succeeded, true, `${tool.name} has no working dispatch path`);
  }

  await assert.rejects(
    executeChatToolCallWithDependencies("sql_query", rawArguments, CONTEXT, {
      execQuery: unusedExecQuery,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      log: unexpectedLog,
    }),
    /Unsupported OpenAI tool call: sql_query/,
  );
});

/**
 * The shared catalog is written for the MCP surface, which registers sql_query
 * and sql_execute. Text that names them here would send the model to a tool this
 * surface never registers, and that dispatch throw aborts the chat turn.
 */
test("no text this surface emits names a tool it does not register", async (): Promise<void> => {
  const dependencies = {
    execQuery: unusedExecQuery,
    listChatWorkspaces: async (): Promise<ReadonlyArray<WorkspaceSummary>> => WORKSPACES,
    loadAllowedSchemaForChatWorkspace: async (): Promise<ReadonlyArray<SchemaRelation>> => RELATIONS,
    log: unexpectedLog,
  };
  const discoveryOutputs = await Promise.all([
    executeChatToolCallWithDependencies("list_workspaces", JSON.stringify({}), CONTEXT, dependencies),
    executeChatToolCallWithDependencies("get_schema", JSON.stringify({}), CONTEXT, dependencies),
    ...AGENT_GUIDE_TOPICS.map((topic) =>
      executeChatToolCallWithDependencies("get_guide", JSON.stringify({ topic }), CONTEXT, dependencies)),
  ]);
  const emittedText: ReadonlyArray<string> = [
    ...OPENAI_CHAT_TOOLS.map((tool) => JSON.stringify(tool)),
    ...discoveryOutputs.map((result) => result.output),
  ];

  assert.deepEqual([...UNREGISTERED_CATALOG_TOOL_NAMES], ["sql_query", "sql_execute"]);
  for (const text of emittedText) {
    for (const name of UNREGISTERED_CATALOG_TOOL_NAMES) {
      assert.ok(
        !text.includes(name),
        `Emitted text names the unregistered tool ${name}: ${text.slice(0, 200)}`,
      );
    }
  }
});

/**
 * A discovery failure the model cannot repair must not hand it internal detail,
 * such as a WorkspaceAccessError or a raw Postgres message, which would reach
 * the user through the reply. The real error belongs in the logs instead.
 */
test("an unexpected discovery failure is redacted for the model and logged in full", async (): Promise<void> => {
  const internalMessage = "password authentication failed for the app role";
  const loggedEvents: Array<string> = [];

  const result = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({}),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      listChatWorkspaces: async (): Promise<never> => {
        throw new Error(internalMessage);
      },
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(parseDiscoveryPayload(result.output).error?.code, "internal_error");
  assert.ok(!result.output.includes(internalMessage));
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0]?.includes(internalMessage));
  assert.equal(
    (JSON.parse(String(loggedEvents[0])) as Readonly<{ requestId?: string }>).requestId,
    CONTEXT.requestId,
  );
});

/** An expected, model-actionable failure keeps its message and stays out of the logs. */
test("a rejected workspaceId keeps its actionable message", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({ workspaceId: "workspace-9" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      listChatWorkspaces: async () => WORKSPACES,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      log: unexpectedLog,
    },
  );

  assert.match(String(parseDiscoveryPayload(result.output).error?.message), /workspace-9/);
});
