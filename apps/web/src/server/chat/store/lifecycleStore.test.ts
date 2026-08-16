import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import { CHAT_MODEL_ID, CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import {
  admitChatRunStartWithQuery,
  cancelActiveChatRunByUserWithQuery,
  cancelChatTurnByUserWithQuery,
  completeChatRunWithQuery,
  persistAssistantCancelledWithQuery,
  persistAssistantTerminalErrorWithQuery,
  prepareChatRunWithQuery,
  prepareFreshChatRunWithQuery,
  recoverStaleChatSessionWithQuery,
  requireAcceptedChatTurnWithQuery,
} from "@/server/chat/store/lifecycleStore";
import { updateAssistantMessageItemWithQuery } from "@/server/chat/store/messageStore";
import {
  ChatSessionConflictError,
  ChatSessionRunTransitionError,
  ChatTurnCancelledError,
} from "@/server/chat/store/shared";
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

const createFreshRunQueryFn = (
  recordedQueries: Array<RecordedQuery>,
  failAssistantInsert: boolean,
): QueryFn => async (text, params): Promise<QueryResult> => {
  recordedQueries.push({ text, params });

  if (text.includes("INSERT INTO public.chat_sessions")) {
    return createQueryResult([createSessionRow("running", String(params[2]))]);
  }

  if (text.includes("INSERT INTO public.chat_items")) {
    const payload = JSON.parse(String(params[3])) as Readonly<{
      role: "user" | "assistant";
      content: ReadonlyArray<Readonly<{ type: "text"; text: string }>>;
    }>;
    if (payload.role === "assistant" && failAssistantInsert) {
      throw new Error("assistant insert failed");
    }
    return createQueryResult([{
      item_id: params[0] === null ? `${payload.role}-1` : String(params[0]),
      session_id: "session-1",
      state: String(params[2]),
      payload,
      created_at: "2026-05-02T13:00:00.000Z",
      updated_at: "2026-05-02T13:00:00.000Z",
    }]);
  }

  if (text.includes("COUNT(*)::text AS user_message_count")) {
    return createQueryResult([{ user_message_count: "1" }]);
  }

  if (text.includes("FROM public.chat_items")) {
    return createQueryResult([{
      item_id: "user-1",
      session_id: "session-1",
      state: "completed",
      payload: {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      created_at: "2026-05-02T13:00:00.000Z",
      updated_at: "2026-05-02T13:00:00.000Z",
    }]);
  }

  throw new Error(`Unexpected query: ${text}`);
};

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

test("prepareFreshChatRunWithQuery creates one running session and the two required items", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  const preparedRun = await prepareFreshChatRunWithQuery(
    createFreshRunQueryFn(recordedQueries, false),
    "user-1",
    "workspace-1",
    [{ type: "text", text: "  Hello\nworld  " }],
  );

  assert.equal(preparedRun.sessionId, "session-1");
  assert.equal(preparedRun.assistantItem.role, "assistant");
  assert.equal(preparedRun.assistantItem.state, "in_progress");
  assert.equal(preparedRun.localMessages.length, 1);
  assert.equal(preparedRun.modelRouting.effectiveModel, CHAT_MODEL_ID);
  assert.equal(
    preparedRun.modelRouting.effectiveReasoningEffort,
    CHAT_MODEL_REASONING_EFFORT,
  );
  assert.equal(recordedQueries.length, 5);
  assert.equal(recordedQueries[0].text.includes("INSERT INTO public.chat_sessions"), true);
  assert.equal(recordedQueries[0].params[3], "Hello world");
  assert.equal(recordedQueries[1].text.includes("INSERT INTO public.chat_items"), true);
  assert.equal(recordedQueries[2].text.includes("FROM public.chat_items"), true);
  assert.equal(recordedQueries[3].text.includes("COUNT(*)::text"), true);
  assert.equal(recordedQueries[4].text.includes("INSERT INTO public.chat_items"), true);
});

test("prepareFreshChatRunWithQuery propagates item failures to the enclosing transaction", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];

  await assert.rejects(
    prepareFreshChatRunWithQuery(
      createFreshRunQueryFn(recordedQueries, true),
      "user-1",
      "workspace-1",
      [{ type: "text", text: "Hello" }],
    ),
    /assistant insert failed/,
  );

  assert.equal(
    recordedQueries.filter((query) => query.text.includes("INSERT INTO public.chat_sessions")).length,
    1,
  );
  assert.equal(
    recordedQueries.filter((query) => query.text.includes("INSERT INTO public.chat_items")).length,
    2,
  );
});

test("prepareChatRunWithQuery explicitly rejects a second run in the same session", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions")) {
      return createQueryResult([createSessionRow("running", "run-1")]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([]);
    }
    if (text.includes("FROM public.chat_items")) {
      return createQueryResult([]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await assert.rejects(
    prepareChatRunWithQuery(
      queryFn,
      "user-1",
      "workspace-1",
      "session-1",
      [{ type: "text", text: "Another message" }],
      "00000000-0000-4000-8000-000000000002",
    ),
    (error: unknown): boolean =>
      error instanceof ChatSessionConflictError
      && error.message.includes("session-1"),
  );

  assert.equal(recordedQueries.length, 4);
  assert.equal(
    recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")),
    false,
  );
});

test("prepareChatRunWithQuery treats a persisted matching turn as already accepted", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000003";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([]);
    }
    if (text.includes("FROM public.chat_items")) {
      return createQueryResult([{ item_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const result = await prepareChatRunWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    [{ type: "text", text: "Same message" }],
    turnId,
  );

  assert.deepEqual(result, {
    kind: "already_accepted",
    sessionId: "session-1",
  });
  assert.equal(
    recordedQueries.some((query) => query.text.includes("INSERT INTO public.chat_items")),
    false,
  );
  assert.equal(
    recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")),
    false,
  );
});

test("prepareChatRunWithQuery rejects a durably cancelled turn before reading or writing chat items", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000004";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([{ turn_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await assert.rejects(
    prepareChatRunWithQuery(
      queryFn,
      "user-1",
      "workspace-1",
      "session-1",
      [{ type: "text", text: "Cancelled message" }],
      turnId,
    ),
    ChatTurnCancelledError,
  );

  assert.match(recordedQueries[1].text, /FOR UPDATE/);
  assert.equal(
    recordedQueries[2].text.includes("FROM public.chat_turn_cancellations"),
    true,
  );
  assert.equal(
    recordedQueries.some((query) => query.text.includes("public.chat_items")),
    false,
  );
  assert.equal(
    recordedQueries.some((query) => query.text.includes("UPDATE public.chat_sessions")),
    false,
  );
});

test("admitChatRunStartWithQuery locks and admits only the exact uncancelled run", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000005";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([]);
    }
    if (text.includes("SET active_run_heartbeat_at")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await admitChatRunStartWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );

  assert.equal(recordedQueries.length, 3);
  assert.match(recordedQueries[0].text, /FOR UPDATE/u);
  assert.deepEqual(recordedQueries[0].params, [
    "user-1",
    "workspace-1",
    "session-1",
  ]);
  assert.match(recordedQueries[1].text, /chat_turn_cancellations/u);
  assert.match(recordedQueries[2].text, /active_run_heartbeat_at/u);
  assert.equal(recordedQueries[2].params[0], "session-1");
  assert.equal(recordedQueries[2].params[1], turnId);
});

test("admitChatRunStartWithQuery rejects a tombstone before touching the runtime heartbeat", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000006";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([{ turn_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await assert.rejects(
    admitChatRunStartWithQuery(
      queryFn,
      "user-1",
      "workspace-1",
      "session-1",
      turnId,
    ),
    ChatTurnCancelledError,
  );

  assert.equal(recordedQueries.length, 2);
  assert.match(recordedQueries[0].text, /FOR UPDATE/u);
  assert.match(recordedQueries[1].text, /chat_turn_cancellations/u);
});

test("requireAcceptedChatTurnWithQuery confirms an uncancelled persisted user turn", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000007";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([]);
    }
    if (text.includes("FROM public.chat_items")) {
      return createQueryResult([{ item_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await requireAcceptedChatTurnWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );

  assert.equal(recordedQueries.length, 3);
  assert.match(recordedQueries[0].text, /FOR UPDATE/u);
  assert.match(recordedQueries[1].text, /chat_turn_cancellations/u);
  assert.match(recordedQueries[2].text, /public\.chat_items/u);
});

test("requireAcceptedChatTurnWithQuery rejects a tombstone before accepting the persisted user turn", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000008";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("FROM public.chat_turn_cancellations")) {
      return createQueryResult([{ turn_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  await assert.rejects(
    requireAcceptedChatTurnWithQuery(
      queryFn,
      "user-1",
      "workspace-1",
      "session-1",
      turnId,
    ),
    ChatTurnCancelledError,
  );

  assert.equal(recordedQueries.length, 2);
  assert.equal(
    recordedQueries.some((query) => query.text.includes("public.chat_items")),
    false,
  );
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

test("cancelChatTurnByUserWithQuery records a tombstone before an unpersisted turn can prepare", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000105";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("INSERT INTO public.chat_turn_cancellations")) {
      return createQueryResult([{ turn_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const result = await cancelChatTurnByUserWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );

  assert.equal(result, "cancellation_recorded");
  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.deepEqual(recordedQueries[1].params, ["session-1", turnId]);
  assert.equal(
    recordedQueries.some((query) => query.text.includes("public.chat_items")),
    false,
  );
});

test("cancelChatTurnByUserWithQuery stops the exact run when send persistence wins the session lock first", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000106";
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    if (text.includes("INSERT INTO public.chat_turn_cancellations")) {
      return createQueryResult([{ turn_id: turnId }]);
    }
    if (text.includes("FROM public.chat_items")) {
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

  const result = await cancelChatTurnByUserWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );

  assert.equal(result, "active_run_cancelled");
  assert.match(recordedQueries[0].text, /FOR UPDATE/);
  assert.equal(
    recordedQueries[1].text.includes("INSERT INTO public.chat_turn_cancellations"),
    true,
  );
  assert.equal(
    recordedQueries.some((query) => query.text.includes("UPDATE public.chat_items")),
    true,
  );
  assert.deepEqual(recordedQueries.at(-1)?.params, [
    "session-1",
    turnId,
    "idle",
  ]);
});

test("cancelChatTurnByUserWithQuery is idempotent across repeated server instances", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const turnId = "00000000-0000-4000-8000-000000000107";
  let cancellationRecorded = false;
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR UPDATE")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("INSERT INTO public.chat_turn_cancellations")) {
      if (cancellationRecorded) {
        return createQueryResult([]);
      }
      cancellationRecorded = true;
      return createQueryResult([{ turn_id: turnId }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const firstResult = await cancelChatTurnByUserWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );
  const secondResult = await cancelChatTurnByUserWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
    turnId,
  );

  assert.equal(firstResult, "cancellation_recorded");
  assert.equal(secondResult, "already_cancelled");
  assert.equal(
    recordedQueries.filter((query) =>
      query.text.includes("INSERT INTO public.chat_turn_cancellations")).length,
    2,
  );
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
