import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_GUIDE_BY_TOPIC,
  AGENT_GUIDE_TOPICS,
  AGENT_TOOLS,
  GET_GUIDE_TOOL,
  getSchemaSuccessInstructions,
  getWorkspaceListSuccessInstructions,
  LIST_WORKSPACES_TOOL,
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import { getAmbiguousMutationInstructions } from "@expense-budget-tracker/agent-shared/agent-results";
import {
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  type ValidatedExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { SchemaRelation } from "@/server/agent/schema";
import { CHAT_SCHEMA_LIMITS, type ChatWorkspaceContext } from "@/server/chat/dataService";
import {
  ChatSessionRunTransitionError,
  ChatTurnCancelledError,
} from "@/server/chat/store";
import { DbTransactionOutcomeUnknownError } from "@/server/db/contextRunner";
import { WorkspaceAccessError } from "@/server/workspaceErrors";
import {
  ChatUserSqlExecutionError,
  throwChatUserSqlExecutionError,
  type ChatSqlExecutionContext,
  type ChatSqlTarget,
  type QueryResult,
} from "@/server/chat/shared";
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

const WORKSPACE_1: WorkspaceSummary = { workspaceId: "workspace-1", name: "Personal" };
const WORKSPACE_2: WorkspaceSummary = { workspaceId: "workspace-2", name: "Business" };
const WORKSPACES: ReadonlyArray<WorkspaceSummary> = [WORKSPACE_1, WORKSPACE_2];

const RELATIONS: ReadonlyArray<SchemaRelation> = [{
  name: "ledger_entries",
  columns: [{ name: "entry_id", type: "text", nullable: false, defaultValue: null }],
}];

const READ_SQL = "SELECT account_id FROM accounts";
const MUTATION_SQL = "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'";

/** Stands in for the shared success envelope apps/web/src/server/chat/shared.ts emits. */
const EXECUTED_SQL_OUTPUT = JSON.stringify({
  ok: true,
  data: { workspace: WORKSPACE_1, statements: [] },
  instructions: SQL_QUERY_TOOL.successInstructions,
});

type SqlExecution = Readonly<{
  validated: ValidatedExpenseSql;
  context: ChatSqlExecutionContext;
  target: ChatSqlTarget;
}>;

type ChatExecQuery = (
  validated: ValidatedExpenseSql,
  context: ChatSqlExecutionContext,
  target: ChatSqlTarget,
) => Promise<QueryResult>;

const createRecordingExecQuery = (
  executions: Array<SqlExecution>,
): ChatExecQuery =>
  async (validated, context, target): Promise<QueryResult> => {
    executions.push({ validated, context, target });
    return { json: EXECUTED_SQL_OUTPUT };
  };

const listAllWorkspaces = async (): Promise<ReadonlyArray<WorkspaceSummary>> => WORKSPACES;

const unusedExecQuery = async (): Promise<never> => {
  throw new Error("execQuery must not be called by this tool call");
};

const unusedListChatWorkspaces = async (): Promise<never> => {
  throw new Error("listChatWorkspaces must not be called by this tool");
};

const unusedLoadAllowedSchemaForChatWorkspace = async (): Promise<never> => {
  throw new Error("loadAllowedSchemaForChatWorkspace must not be called by this tool");
};

/**
 * A pg error carries its SQLSTATE on `code`, and that code is all the execution
 * path reads to decide whether the statement itself was at fault.
 */
const createPgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** Only an unexpected failure may log, so every other path proves it stays silent. */
const unexpectedLog = (event: unknown): never => {
  throw new Error(`A chat tool logged an unexpected error: ${JSON.stringify(event)}`);
};

type ToolResultPayload = Readonly<{
  ok: boolean;
  data?: Readonly<Record<string, unknown>>;
  error?: Readonly<{ code: string; message: string; details?: Readonly<Record<string, unknown>> }>;
  instructions: string;
}>;

const parseToolPayload = (output: string): ToolResultPayload =>
  JSON.parse(output) as ToolResultPayload;

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

test("sql_query forwards the exact session and turn scope to SQL execution", async (): Promise<void> => {
  const context: OpenAIToolContext = {
    requestId: "request-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  let receivedContext: ChatSqlExecutionContext | null = null;

  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    context,
    {
      execQuery: async (_validated, executionContext) => {
        receivedContext = executionContext;
        return { json: EXECUTED_SQL_OUTPUT };
      },
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.error, null);
  assert.equal(result.isMutating, false);
  assert.equal(result.workspaceId, "workspace-1");
  assert.deepEqual(receivedContext, context);
});

/**
 * The two SQL tools are the same execution path behind two validators, and which
 * validator runs is the whole contract: a read sent to sql_execute and a mutation
 * sent to sql_query must both be refused before anything reaches the database.
 */
test("each SQL tool runs the single-statement validator that matches it", async (): Promise<void> => {
  const executions: Array<SqlExecution> = [];
  const dependencies = {
    execQuery: createRecordingExecQuery(executions),
    log: unexpectedLog,
    listChatWorkspaces: listAllWorkspaces,
    loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
  };

  const read = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    dependencies,
  );
  const mutation = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    dependencies,
  );
  const mutationSentToRead = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    dependencies,
  );
  const readSentToWrite = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    dependencies,
  );

  assert.equal(read.succeeded, true);
  assert.equal(read.isMutating, false);
  assert.equal(read.output, EXECUTED_SQL_OUTPUT);
  assert.equal(mutation.succeeded, true);
  assert.equal(mutation.isMutating, true);
  // Only the two accepted calls reached execution.
  assert.deepEqual(executions.map((execution) => execution.validated.sql), [READ_SQL, MUTATION_SQL]);
  assert.deepEqual(executions.map((execution) => execution.target.instructions), [
    SQL_QUERY_TOOL.successInstructions,
    SQL_EXECUTE_TOOL.successInstructions,
  ]);
  assert.equal(mutationSentToRead.succeeded, false);
  assert.equal(parseToolPayload(mutationSentToRead.output).error?.code, "read_only_sql_required");
  assert.equal(readSentToWrite.succeeded, false);
  assert.equal(parseToolPayload(readSentToWrite.output).error?.code, "mutation_sql_required");
});

test("a multi-statement script is rejected with single_statement_required", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: `${READ_SQL}; SELECT currency FROM accounts` }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  const payload = parseToolPayload(result.output);
  assert.equal(payload.error?.code, "single_statement_required");
  assert.match(payload.instructions, /call sql_query once for each statement/u);
});

/**
 * Stored transcripts replay query_database into the model, so the name has to
 * keep dispatching even though it is no longer advertised. It runs the same
 * single-statement policy as the tools that replaced it, and its results name
 * those tools so an old session moves onto them.
 */
test("the deprecated query_database alias runs the policy of the tool that replaced it", async (): Promise<void> => {
  const executions: Array<SqlExecution> = [];
  const dependencies = {
    execQuery: createRecordingExecQuery(executions),
    log: unexpectedLog,
    listChatWorkspaces: listAllWorkspaces,
    loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
  };

  const read = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    dependencies,
  );
  const mutation = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    dependencies,
  );
  const script = await executeChatToolCallWithDependencies(
    "query_database",
    JSON.stringify({ sql: `${MUTATION_SQL}; ${MUTATION_SQL}` }),
    CONTEXT,
    dependencies,
  );

  assert.equal(read.succeeded, true);
  assert.equal(read.isMutating, false);
  assert.equal(mutation.succeeded, true);
  assert.equal(mutation.isMutating, true);
  assert.deepEqual(executions.map((execution) => execution.target.instructions), [
    SQL_QUERY_TOOL.successInstructions,
    SQL_EXECUTE_TOOL.successInstructions,
  ]);
  assert.equal(script.succeeded, false);
  const payload = parseToolPayload(script.output);
  assert.equal(payload.error?.code, "single_statement_required");
  assert.match(payload.instructions, /call sql_execute once for each statement/u);
});

test("sql_execute runs against an explicit workspaceId the caller is a member of", async (): Promise<void> => {
  const executions: Array<SqlExecution> = [];

  const result = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL, workspaceId: "workspace-2" }),
    CONTEXT,
    {
      execQuery: createRecordingExecQuery(executions),
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.workspaceId, "workspace-2");
  assert.deepEqual(executions[0]?.target.workspace, WORKSPACE_2);
  // The session scope is unchanged, because the chat session row the mutation
  // turn lock reads lives in the workspace the browser has open.
  assert.equal(executions[0]?.context.workspaceId, "workspace-1");
});

test("sql_execute rejects a workspaceId outside the caller's workspaces before executing", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL, workspaceId: "workspace-9" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.workspaceId, null);
  const payload = parseToolPayload(result.output);
  assert.equal(payload.error?.code, "workspace_not_found");
  assert.deepEqual(payload.error?.details, { workspaceId: "workspace-9" });
});

/** A rejected statement is the one failure the model can repair, so it keeps its message. */
test("a failed statement keeps its raw message in the shared error envelope", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> => {
        throw new ChatUserSqlExecutionError(
          "relation missing_accounts does not exist",
          new Error("relation missing_accounts does not exist"),
        );
      },
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.isMutating, false);
  assert.equal(result.workspaceId, null);
  assert.deepEqual(result.error, {
    name: "ChatUserSqlExecutionError",
    message: "relation missing_accounts does not exist",
  });
  assert.deepEqual(parseToolPayload(result.output), {
    ok: false,
    error: {
      code: "sql_execution_failed",
      message: "relation missing_accounts does not exist",
    },
    instructions: "Review SQL syntax, relation names, values, and constraints, then call sql_query again.",
  });
});

/**
 * The same call site raises everything the execution step can fail on, not just
 * the statement. Only the error the executor blamed the statement for is
 * recognized, so an infrastructure failure alongside it is redacted rather than
 * answered with an invitation to rewrite SQL that was never at fault.
 */
test("a non-statement execution failure is redacted instead of blamed on the SQL", async (): Promise<void> => {
  const internalMessage = "password authentication failed for user \"app\"";
  const loggedEvents: Array<string> = [];

  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> => {
        throw new Error(internalMessage);
      },
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.workspaceId, null);
  assert.equal(parseToolPayload(result.output).error?.code, "internal_error");
  assert.ok(!result.output.includes(internalMessage));
  assert.ok(!result.output.includes("call sql_query again"));
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0]?.includes(internalMessage));
  assert.equal(
    (JSON.parse(String(loggedEvents[0])) as Readonly<{ requestId?: string }>).requestId,
    CONTEXT.requestId,
  );
});

/**
 * The two sides of the real class gate, raised the way execution raises them.
 * A data exception is a statement the model can repair, so it is wrapped and
 * its message forwarded.
 */
test("a data exception raised by the real class gate keeps its message", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> =>
        throwChatUserSqlExecutionError(createPgError("22012", "division by zero")),
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.deepEqual(parseToolPayload(result.output), {
    ok: false,
    error: {
      code: "sql_execution_failed",
      message: "division by zero",
    },
    instructions: "Review SQL syntax, relation names, values, and constraints, then call sql_query again.",
  });
});

/**
 * The other side: the class gate lets a cancelled statement through untouched,
 * because rewriting SQL cannot make it faster. Without its own branch it would
 * land in the redacted default and the model would be told to retry the same
 * query on a fresh full deadline. The shared deadline instructions reach the
 * model verbatim: this statement was dispatched before it was cancelled, and
 * the abort that cancellation performs is what leaves nothing applied and keeps
 * their retry guidance true for a mutation.
 */
test("a statement cancelled at its timeout is answered as a deadline failure", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> =>
        throwChatUserSqlExecutionError(
          createPgError("57014", "canceling statement due to statement timeout"),
        ),
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.isMutating, true);
  assert.equal(result.workspaceId, null);
  assert.deepEqual(parseToolPayload(result.output), {
    ok: false,
    error: {
      code: "request_deadline_exceeded",
      message: `SQL execution was cancelled after exceeding its ${String(MCP_SQL_STATEMENT_TIMEOUT_MS)} ms deadline. Any writes in this call were rolled back. Ask for less work per call: a shorter date range or fewer rows`,
      details: { timeoutMs: MCP_SQL_STATEMENT_TIMEOUT_MS, retryable: true },
    },
    instructions: "Retry sql_execute. The deadline expired before the mutation was dispatched, so no mutation was applied.",
  });
  assert.ok(!result.output.includes("canceling statement"));
});

/**
 * A read commits nothing, so a lost transaction outcome on sql_query is an
 * infrastructure failure and not the ambiguous-write warning sql_execute gets.
 */
test("a lost transaction outcome on a read is redacted rather than reported as ambiguous", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> => {
        throw new DbTransactionOutcomeUnknownError(
          "commit",
          new Error("Connection terminated unexpectedly"),
          undefined,
        );
      },
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(parseToolPayload(result.output).error?.code, "internal_error");
  assert.ok(!result.output.includes("Connection terminated unexpectedly"));
  assert.ok(!result.output.includes("call sql_query again"));
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0]?.includes("DbTransactionOutcomeUnknownError"));
});

test("list_workspaces returns every accessible workspace without touching SQL", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "list_workspaces",
    JSON.stringify({}),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(result.isMutating, false);
  assert.deepEqual(parseToolPayload(result.output), {
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
      listChatWorkspaces: async () => [WORKSPACE_1],
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  const payload = parseToolPayload(result.output);
  assert.equal(payload.instructions, getWorkspaceListSuccessInstructions(1, WEB_CHAT_SURFACE_PROFILE));
  assert.notEqual(payload.instructions, LIST_WORKSPACES_TOOL.successInstructions);
});

test("get_schema falls back to the session workspace when workspaceId is omitted", async (): Promise<void> => {
  const requestedWorkspaceIds: Array<string> = [];
  const dependencies = {
    execQuery: unusedExecQuery,
    log: unexpectedLog,
    listChatWorkspaces: listAllWorkspaces,
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
  assert.deepEqual(parseToolPayload(omitted.output), {
    ok: true,
    data: {
      workspace: WORKSPACE_1,
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
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: async (_context, workspaceId) => {
        requestedWorkspaceId = workspaceId;
        return RELATIONS;
      },
    },
  );

  assert.equal(result.succeeded, true);
  assert.equal(requestedWorkspaceId, "workspace-2");
  assert.deepEqual(parseToolPayload(result.output).data?.workspace, WORKSPACE_2);
});

test("get_schema rejects a workspaceId outside the caller's workspaces before reading it", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "get_schema",
    JSON.stringify({ workspaceId: "workspace-9" }),
    CONTEXT,
    {
      execQuery: unusedExecQuery,
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  const payload = parseToolPayload(result.output);
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
    assert.deepEqual(parseToolPayload(result.output), {
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
  assert.equal(parseToolPayload(result.output).error?.code, "invalid_tool_arguments");
});

/**
 * The catalog's `required` flags and the rendered schema are two independent
 * declarations of the same contract, and the MCP surface derives its own from
 * zod. A strict OpenAI tool lists every property in `required`, so the rendered
 * required-ness lives in which properties are non-nullable.
 */
test("the rendered tool schemas match the catalog's required flags", (): void => {
  for (const tool of AGENT_TOOLS) {
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
  for (const tool of OPENAI_CHAT_TOOLS) {
    // Unknown properties are ignored, so one argument object serves every tool
    // once the statement kind matches the tool that validates it.
    const rawArguments = JSON.stringify({
      sql: tool.name === SQL_EXECUTE_TOOL.name ? MUTATION_SQL : READ_SQL,
      topic: AGENT_GUIDE_TOPICS[0],
      workspaceId: null,
    });

    const result = await executeChatToolCallWithDependencies(
      tool.name,
      rawArguments,
      CONTEXT,
      {
        execQuery: async () => ({ json: EXECUTED_SQL_OUTPUT }),
        listChatWorkspaces: listAllWorkspaces,
        loadAllowedSchemaForChatWorkspace: async () => RELATIONS,
        log: unexpectedLog,
      },
    );

    assert.equal(result.succeeded, true, `${tool.name} has no working dispatch path`);
  }

  await assert.rejects(
    executeChatToolCallWithDependencies("run_report", JSON.stringify({}), CONTEXT, {
      execQuery: unusedExecQuery,
      listChatWorkspaces: unusedListChatWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      log: unexpectedLog,
    }),
    /Unsupported OpenAI tool call: run_report/u,
  );
});

/**
 * This surface now registers the shared catalog unchanged, and query_database is
 * dispatchable only for stored transcripts. Advertising it, or naming it in a
 * result, would keep new turns on a tool the catalog no longer describes.
 */
test("this surface registers the whole catalog and never names the deprecated alias", async (): Promise<void> => {
  const dependencies = {
    execQuery: unusedExecQuery,
    listChatWorkspaces: listAllWorkspaces,
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

  assert.deepEqual(
    OPENAI_CHAT_TOOLS.map((tool) => tool.name),
    AGENT_TOOLS.map((tool) => tool.name),
  );
  for (const text of emittedText) {
    assert.ok(
      !text.includes("query_database"),
      `Emitted text names the unadvertised query_database alias: ${text.slice(0, 200)}`,
    );
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
  assert.equal(parseToolPayload(result.output).error?.code, "internal_error");
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
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      log: unexpectedLog,
    },
  );

  assert.match(String(parseToolPayload(result.output).error?.message), /workspace-9/u);
});

/**
 * The SQL tools resolve the workspace before they execute, so a workspace lookup
 * failure now happens inside them too. It carries internal detail the model can
 * repair nothing with, so it belongs in the logs rather than in the reply.
 */
test("an unexpected workspace lookup failure on a SQL tool is redacted and logged", async (): Promise<void> => {
  const internalMessage = "password authentication failed for the app role";
  const loggedEvents: Array<string> = [];

  const result = await executeChatToolCallWithDependencies(
    "sql_query",
    JSON.stringify({ sql: READ_SQL }),
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
  assert.equal(result.workspaceId, null);
  assert.equal(parseToolPayload(result.output).error?.code, "internal_error");
  assert.ok(!result.output.includes(internalMessage));
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0]?.includes(internalMessage));
  assert.equal(
    (JSON.parse(String(loggedEvents[0])) as Readonly<{ requestId?: string }>).requestId,
    CONTEXT.requestId,
  );
});

/**
 * A mutation whose COMMIT never reported back may already be durable. Telling
 * the model to run the statement again would duplicate ledger rows, so this is
 * the one execution failure that must send it to verify instead.
 */
test("an unknown mutation outcome sends sql_execute to verify instead of retrying", async (): Promise<void> => {
  const result = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> => {
        throw new DbTransactionOutcomeUnknownError(
          "commit",
          new Error("Connection terminated unexpectedly"),
          undefined,
        );
      },
      log: unexpectedLog,
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(result.workspaceId, null);
  const payload = parseToolPayload(result.output);
  assert.equal(payload.error?.code, "sql_mutation_outcome_unknown");
  assert.deepEqual(payload.error?.details, { outcome: "unknown", retryable: false });
  assert.equal(payload.instructions, getAmbiguousMutationInstructions());
  assert.ok(!result.output.includes("Connection terminated unexpectedly"));
  assert.ok(!result.output.includes("call sql_execute again"));
});

/**
 * Both errors come from the mutation turn lock the call runs inside: the user
 * stopped the turn, or the session moved on to another run. Neither may be
 * answered with an instruction to repeat the call.
 */
test("a turn that is no longer active is never told to retry the call", async (): Promise<void> => {
  const abandonedTurnErrors: ReadonlyArray<Error> = [
    new ChatTurnCancelledError("session-1", "turn-1"),
    new ChatSessionRunTransitionError({
      sessionId: "session-1",
      activeRunId: "run-2",
      operation: "execute mutating chat SQL",
    }),
  ];

  for (const abandonedTurnError of abandonedTurnErrors) {
    const result = await executeChatToolCallWithDependencies(
      "sql_execute",
      JSON.stringify({ sql: MUTATION_SQL }),
      CONTEXT,
      {
        execQuery: async (): Promise<never> => {
          throw abandonedTurnError;
        },
        log: unexpectedLog,
        listChatWorkspaces: listAllWorkspaces,
        loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
      },
    );

    assert.equal(result.succeeded, false);
    assert.equal(result.workspaceId, null);
    const payload = parseToolPayload(result.output);
    assert.equal(payload.error?.code, "chat_turn_not_active");
    assert.deepEqual(payload.error?.details, { retryable: false });
    assert.ok(!result.output.includes("call sql_execute again"));
  }
});

/**
 * Membership was already verified against list_workspaces, so the provisioning
 * step inside execQuery can only refuse it after a mid-call change. Its message
 * names the user, which must never reach the model or the reply.
 */
test("a workspace access failure inside execution is redacted and logged", async (): Promise<void> => {
  const loggedEvents: Array<string> = [];

  const result = await executeChatToolCallWithDependencies(
    "sql_execute",
    JSON.stringify({ sql: MUTATION_SQL }),
    CONTEXT,
    {
      execQuery: async (): Promise<never> => {
        throw new WorkspaceAccessError(CONTEXT.userId, CONTEXT.workspaceId);
      },
      log: (event): void => {
        loggedEvents.push(JSON.stringify(event));
      },
      listChatWorkspaces: listAllWorkspaces,
      loadAllowedSchemaForChatWorkspace: unusedLoadAllowedSchemaForChatWorkspace,
    },
  );

  assert.equal(result.succeeded, false);
  assert.equal(parseToolPayload(result.output).error?.code, "internal_error");
  assert.ok(!result.output.includes(CONTEXT.userId));
  assert.equal(loggedEvents.length, 1);
  assert.ok(loggedEvents[0]?.includes("WorkspaceAccessError"));
});
