import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  cancelActiveChatRunByUserWithQuery,
  completeChatRunWithQuery,
  persistAssistantCancelledWithQuery,
  persistAssistantTerminalErrorWithQuery,
  recoverStaleChatSessionWithQuery,
} from "@/server/chat/store/lifecycleStore";
import { updateAssistantMessageItemWithQuery } from "@/server/chat/store/messageStore";
import { ChatSessionRunTransitionError } from "@/server/chat/store/shared";
import type { QueryFn } from "@/server/db/contextRunner";

type RecordedQuery = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type SessionStatus = "idle" | "running" | "interrupted";

type AssistantState = "in_progress" | "completed";

type StaleRecoveryQueryOptions = Readonly<{
  sessionStatus: SessionStatus;
  activeRunId: string | null;
  lastAssistantState: AssistantState | null;
  recordedQueries: Array<RecordedQuery>;
}>;

type UserCancelQueryOptions = Readonly<{
  sessionStatus: SessionStatus;
  activeRunId: string | null;
  recordedQueries: Array<RecordedQuery>;
}>;

const createQueryResult = (
  rows: ReadonlyArray<unknown>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createSessionRow = (
  status: SessionStatus,
  activeRunId: string | null,
): Readonly<Record<string, string | null>> => ({
  session_id: "session-1",
  status,
  active_run_id: activeRunId,
  active_run_heartbeat_at: activeRunId === null ? null : "2026-05-02T13:00:00.000Z",
  main_content_invalidation_version: "0",
  updated_at: "2026-05-02T13:00:00.000Z",
});

const createChatItemRow = (
  state: "in_progress" | "completed" | "error" | "cancelled",
): Readonly<Record<string, unknown>> => ({
  item_id: `assistant-${state}`,
  session_id: "session-1",
  state,
  payload: {
    role: "assistant",
    content: [{ type: "text", text: "Answer" }],
  },
  created_at: "2026-05-02T13:00:00.000Z",
  updated_at: "2026-05-02T13:00:00.000Z",
});

const createStaleRecoveryQueryFn = (options: StaleRecoveryQueryOptions): QueryFn => async (
  text,
  params,
): Promise<QueryResult> => {
  options.recordedQueries.push({ text, params });

  if (text.includes("FROM public.chat_sessions") && text.includes("WHERE user_id = $1")) {
    return createQueryResult([createSessionRow(options.sessionStatus, options.activeRunId)]);
  }

  if (text.includes("FROM public.chat_items") && text.includes("ORDER BY item_order ASC")) {
    return options.lastAssistantState === null
      ? createQueryResult([])
      : createQueryResult([createChatItemRow(options.lastAssistantState)]);
  }

  if (text.includes("UPDATE public.chat_items")) {
    return createQueryResult([createChatItemRow("completed")]);
  }

  if (text.includes("INSERT INTO public.chat_items")) {
    return createQueryResult([createChatItemRow("error")]);
  }

  if (text.includes("UPDATE public.chat_sessions")) {
    return createQueryResult([createSessionRow(params[2] === "interrupted" ? "interrupted" : "idle", null)]);
  }

  throw new Error(`Unexpected query: ${text}`);
};

const createActiveRunWriteQueryFn = (
  activeRunMatches: boolean,
  recordedQueries: Array<RecordedQuery>,
): QueryFn => async (text, params): Promise<QueryResult> => {
  recordedQueries.push({ text, params });

  if (
    text.includes("FROM public.chat_sessions")
    && text.includes("active_run_id = $2")
    && text.includes("status = 'running'")
    && text.includes("FOR UPDATE")
  ) {
    return activeRunMatches
      ? createQueryResult([createSessionRow("running", "run-1")])
      : createQueryResult([]);
  }

  if (text.includes("UPDATE public.chat_items")) {
    return createQueryResult([createChatItemRow("completed")]);
  }

  if (text.includes("INSERT INTO public.chat_items")) {
    return createQueryResult([createChatItemRow("error")]);
  }

  if (text.includes("UPDATE public.chat_sessions")) {
    return createQueryResult([createSessionRow(params[2] === "interrupted" ? "interrupted" : "idle", null)]);
  }

  throw new Error(`Unexpected query: ${text}`);
};

const createUserCancelQueryFn = (options: UserCancelQueryOptions): QueryFn => async (
  text,
  params,
): Promise<QueryResult> => {
  options.recordedQueries.push({ text, params });

  if (text.includes("FROM public.chat_sessions") && text.includes("WHERE user_id = $1")) {
    return createQueryResult([createSessionRow(options.sessionStatus, options.activeRunId)]);
  }

  if (text.includes("FROM public.chat_sessions") && text.includes("WHERE session_id = $1") && text.includes("FOR UPDATE")) {
    return createQueryResult([createSessionRow(options.sessionStatus, options.activeRunId)]);
  }

  if (text.includes("FROM public.chat_items") && text.includes("ORDER BY item_order ASC")) {
    return createQueryResult([createChatItemRow("in_progress")]);
  }

  if (text.includes("UPDATE public.chat_items")) {
    return createQueryResult([createChatItemRow("cancelled")]);
  }

  if (text.includes("UPDATE public.chat_sessions")) {
    return createQueryResult([createSessionRow("idle", null)]);
  }

  throw new Error(`Unexpected query: ${text}`);
};

const createTerminalRunParams = (): Readonly<{
  sessionId: string;
  activeRunId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<{ type: "text"; text: string }>;
}> => ({
  sessionId: "session-1",
  activeRunId: "run-1",
  assistantItemId: "assistant-1",
  assistantContent: [{ type: "text", text: "Answer" }],
});

const withSuppressedConsoleLog = async (
  run: () => Promise<void>,
): Promise<void> => {
  const originalLog = console.log;
  console.log = (): void => undefined;
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
};

test("completeChatRunWithQuery locks the active run before updating the assistant item", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  await completeChatRunWithQuery(
    createActiveRunWriteQueryFn(true, recordedQueries),
    createTerminalRunParams(),
  );

  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.match(recordedQueries[0].text, /active_run_id = \$2/);
  assert.equal(recordedQueries[1].text.includes("UPDATE public.chat_items"), true);
  assert.equal(recordedQueries[2].text.includes("UPDATE public.chat_sessions"), true);
});

test("persistAssistantTerminalErrorWithQuery locks the active run before updating chat items", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const params = createTerminalRunParams();

  await persistAssistantTerminalErrorWithQuery(
    createActiveRunWriteQueryFn(true, recordedQueries),
    {
      ...params,
      errorMessage: "Provider failed",
      sessionState: "idle",
    },
  );

  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.equal(recordedQueries[1].text.includes("UPDATE public.chat_items"), true);
  assert.equal(recordedQueries.at(-1)?.text.includes("UPDATE public.chat_sessions"), true);
});

test("persistAssistantCancelledWithQuery locks the active run before updating the assistant item", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  await persistAssistantCancelledWithQuery(
    createActiveRunWriteQueryFn(true, recordedQueries),
    createTerminalRunParams(),
  );

  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.equal(recordedQueries[1].text.includes("UPDATE public.chat_items"), true);
  assert.equal(recordedQueries[2].text.includes("UPDATE public.chat_sessions"), true);
});

test("updateAssistantMessageItemWithQuery does not update chat items when the active run changed", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  await assert.rejects(
    updateAssistantMessageItemWithQuery(
      createActiveRunWriteQueryFn(false, recordedQueries),
      {
        sessionId: "session-1",
        activeRunId: "run-1",
        itemId: "assistant-1",
        content: [{ type: "text", text: "Answer" }],
        state: "in_progress",
      },
    ),
    ChatSessionRunTransitionError,
  );

  assert.equal(recordedQueries.length, 1);
  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), false);
});

test("cancelActiveChatRunByUserWithQuery cancels the matching expected active run", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await cancelActiveChatRunByUserWithQuery(
    createUserCancelQueryFn({
      sessionStatus: "running",
      activeRunId: "run-1",
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    "session-1",
    "run-1",
  );

  assert.equal(result, "cancelled");
  assert.equal(recordedQueries.some((query) => query.text.includes("FROM public.chat_items")), true);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), true);
  assert.deepEqual(recordedQueries.at(-1)?.params, ["session-1", "run-1", "idle"]);
});

test("cancelActiveChatRunByUserWithQuery skips item writes when the active run changed", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await cancelActiveChatRunByUserWithQuery(
    createUserCancelQueryFn({
      sessionStatus: "running",
      activeRunId: "run-2",
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    "session-1",
    "run-1",
  );

  assert.equal(result, "run_changed");
  assert.equal(recordedQueries.some((query) => query.text.includes("FROM public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")), false);
});

test("cancelActiveChatRunByUserWithQuery skips item writes when the session is not running", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await cancelActiveChatRunByUserWithQuery(
    createUserCancelQueryFn({
      sessionStatus: "idle",
      activeRunId: null,
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    "session-1",
    "run-1",
  );

  assert.equal(result, "not_running");
  assert.equal(recordedQueries.some((query) => query.text.includes("FROM public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")), false);
});

test("recoverStaleChatSessionWithQuery interrupts stale in-progress assistant messages", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await recoverStaleChatSessionWithQuery(
    createStaleRecoveryQueryFn({
      sessionStatus: "running",
      activeRunId: "run-1",
      lastAssistantState: "in_progress",
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    {
      sessionId: "session-1",
      expectedActiveRunId: "run-1",
      errorMessage: "interrupted",
    },
  );

  assert.equal(result, "interrupted");
  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.match(recordedQueries[0].text, /WHERE user_id = \$1/);
  assert.match(recordedQueries[0].text, /AND workspace_id = \$2/);
  assert.match(recordedQueries[0].text, /AND session_id = \$3/);
  assert.deepEqual(recordedQueries[0].params, ["user-1", "workspace-1", "session-1"]);
  assert.equal(recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")), true);
  assert.deepEqual(recordedQueries.at(-1)?.params, ["session-1", "run-1", "interrupted"]);
});

test("recoverStaleChatSessionWithQuery recovers completed stale runs without inserting fake errors", async (): Promise<void> => {
  await withSuppressedConsoleLog(async (): Promise<void> => {
    const recordedQueries: Array<RecordedQuery> = [];

    const result = await recoverStaleChatSessionWithQuery(
      createStaleRecoveryQueryFn({
        sessionStatus: "running",
        activeRunId: "run-1",
        lastAssistantState: "completed",
        recordedQueries,
      }),
      "user-1",
      "workspace-1",
      {
        sessionId: "session-1",
        expectedActiveRunId: "run-1",
        errorMessage: "interrupted",
      },
    );

    assert.equal(result, "completed_recovered");
    assert.equal(recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")), false);
    assert.deepEqual(recordedQueries.at(-1)?.params, ["session-1", "run-1", "idle"]);
  });
});

test("recoverStaleChatSessionWithQuery skips recovery when the active run changed", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await recoverStaleChatSessionWithQuery(
    createStaleRecoveryQueryFn({
      sessionStatus: "running",
      activeRunId: "run-2",
      lastAssistantState: "in_progress",
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    {
      sessionId: "session-1",
      expectedActiveRunId: "run-1",
      errorMessage: "interrupted",
    },
  );

  assert.equal(result, "run_changed");
  assert.equal(recordedQueries.some((query) => query.text.includes("FROM public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")), false);
});

test("recoverStaleChatSessionWithQuery skips recovery when the session is already finalized", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const result = await recoverStaleChatSessionWithQuery(
    createStaleRecoveryQueryFn({
      sessionStatus: "idle",
      activeRunId: null,
      lastAssistantState: "in_progress",
      recordedQueries,
    }),
    "user-1",
    "workspace-1",
    {
      sessionId: "session-1",
      expectedActiveRunId: "run-1",
      errorMessage: "interrupted",
    },
  );

  assert.equal(result, "not_running");
  assert.equal(recordedQueries.some((query) => query.text.includes("FROM public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")), false);
  assert.equal(recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")), false);
});
