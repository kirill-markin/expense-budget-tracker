import type { StoredMessage } from "@/lib/chatHistory";
import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import type { ChatMessage, ContentPart } from "@/server/chat/types";

export type ChatSessionRunState = "idle" | "running" | "interrupted";
export type ChatItemState = "in_progress" | "completed" | "error" | "cancelled";

type ChatSessionRow = Readonly<{
  session_id: string;
  status: ChatSessionRunState;
  active_run_heartbeat_at: string | null;
  openai_conversation_id: string | null;
  updated_at: string;
}>;

type ChatItemPayload = Readonly<{
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
}>;

type ChatItemRow = Readonly<{
  item_id: string;
  session_id: string;
  state: ChatItemState;
  payload: ChatItemPayload;
  created_at: string;
  updated_at: string;
}>;

export class ChatSessionNotFoundError extends Error {
  public constructor(sessionId: string) {
    super(`Chat session not found: ${sessionId}`);
    this.name = "ChatSessionNotFoundError";
  }
}

export class ChatSessionConflictError extends Error {
  public constructor(sessionId: string) {
    super(`Chat session already has an active run: ${sessionId}`);
    this.name = "ChatSessionConflictError";
  }
}

export type PersistedChatMessageItem = Readonly<{
  itemId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
  state: ChatItemState;
  isError: boolean;
  isStopped: boolean;
  timestamp: number;
  updatedAt: number;
}>;

export type ChatSessionSnapshot = Readonly<{
  sessionId: string;
  runState: ChatSessionRunState;
  updatedAt: number;
  activeRunHeartbeatAt: number | null;
  messages: ReadonlyArray<StoredMessage>;
}>;

export type PreparedChatRun = Readonly<{
  sessionId: string;
  assistantItem: PersistedChatMessageItem;
  localMessages: ReadonlyArray<ChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  conversationId: string | null;
}>;

type InsertChatItemParams = Readonly<{
  sessionId: string;
  role: "user" | "assistant";
  state: ChatItemState;
  content: ReadonlyArray<ContentPart>;
}>;

type UpdateChatMessageItemParams = Readonly<{
  itemId: string;
  content: ReadonlyArray<ContentPart>;
  state: ChatItemState;
}>;

type PersistAssistantTerminalErrorParams = Readonly<{
  sessionId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
  errorMessage: string;
  sessionState: ChatSessionRunState;
}>;

type PersistAssistantCancelledParams = Readonly<{
  sessionId: string;
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
}>;

type CompleteChatRunParams = Readonly<{
  assistantItemId: string;
  assistantContent: ReadonlyArray<ContentPart>;
  conversationId: string;
}>;

type PersistChatSessionConversationIdParams = Readonly<{
  sessionId: string;
  conversationId: string;
}>;

const SELECT_SESSION_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND session_id = $3
`;

const SELECT_SESSION_FOR_UPDATE_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
  FROM public.chat_sessions
  WHERE session_id = $1
  FOR UPDATE
`;

const SELECT_LATEST_SESSION_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
  ORDER BY created_at DESC, session_id DESC
  LIMIT 1
`;

const INSERT_SESSION_SQL = `
  INSERT INTO public.chat_sessions (
    user_id,
    workspace_id,
    status,
    active_run_heartbeat_at,
    openai_conversation_id,
    updated_at
  )
  VALUES ($1, $2, 'idle', NULL, NULL, now())
  RETURNING session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
`;

const LIST_CHAT_ITEMS_SQL = `
  SELECT
    item_id,
    session_id,
    state,
    payload,
    created_at,
    updated_at
  FROM public.chat_items
  WHERE session_id = $1
    AND item_kind = 'message'
  ORDER BY item_order ASC
`;

const INSERT_CHAT_ITEM_SQL = `
  WITH inserted_item AS (
    INSERT INTO public.chat_items (
      session_id,
      item_kind,
      state,
      payload,
      updated_at
    )
    VALUES ($1, 'message', $2, $3::jsonb, now())
    RETURNING item_id, session_id, state, payload, created_at, updated_at
  ),
  touched_session AS (
    UPDATE public.chat_sessions
    SET updated_at = now()
    WHERE session_id = (SELECT session_id FROM inserted_item)
  )
  SELECT item_id, session_id, state, payload, created_at, updated_at
  FROM inserted_item
`;

const UPDATE_CHAT_ITEM_SQL = `
  WITH updated_item AS (
    UPDATE public.chat_items
    SET payload = $2::jsonb,
        state = $3,
        updated_at = now()
    WHERE item_id = $1
    RETURNING item_id, session_id, state, payload, created_at, updated_at
  ),
  touched_session AS (
    UPDATE public.chat_sessions
    SET updated_at = now()
    WHERE session_id = (SELECT session_id FROM updated_item)
  )
  SELECT item_id, session_id, state, payload, created_at, updated_at
  FROM updated_item
`;

const UPDATE_CHAT_SESSION_STATUS_SQL = `
  UPDATE public.chat_sessions
  SET status = $2,
      active_run_heartbeat_at = $3,
      updated_at = now()
  WHERE session_id = $1
  RETURNING session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
`;

const UPDATE_CHAT_SESSION_COMPLETION_SQL = `
  UPDATE public.chat_sessions
  SET status = 'idle',
      active_run_heartbeat_at = NULL,
      openai_conversation_id = $2,
      updated_at = now()
  WHERE session_id = $1
  RETURNING session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
`;

const UPDATE_CHAT_SESSION_CONVERSATION_ID_SQL = `
  UPDATE public.chat_sessions
  SET openai_conversation_id = $2,
      updated_at = now()
  WHERE session_id = $1
  RETURNING session_id, status, active_run_heartbeat_at, openai_conversation_id, updated_at
`;

const mapSessionRow = (row: ChatSessionRow): ChatSessionSnapshot => ({
  sessionId: row.session_id,
  runState: row.status,
  updatedAt: new Date(row.updated_at).getTime(),
  activeRunHeartbeatAt: row.active_run_heartbeat_at === null
    ? null
    : new Date(row.active_run_heartbeat_at).getTime(),
  messages: [],
});

const mapChatItemRow = (row: ChatItemRow): PersistedChatMessageItem => ({
  itemId: row.item_id,
  sessionId: row.session_id,
  role: row.payload.role,
  content: row.payload.content,
  state: row.state,
  isError: row.state === "error",
  isStopped: row.state === "cancelled",
  timestamp: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

const requireSessionRow = (
  row: ChatSessionRow | undefined,
  operation: string,
): ChatSessionRow => {
  if (row === undefined) {
    throw new Error(`Chat session ${operation} failed: query returned no row`);
  }

  return row;
};

const requireChatItemRow = (
  row: ChatItemRow | undefined,
  operation: string,
): ChatItemRow => {
  if (row === undefined) {
    throw new Error(`Chat item ${operation} failed: query returned no row`);
  }

  return row;
};

const toChatItemPayload = (
  role: "user" | "assistant",
  content: ReadonlyArray<ContentPart>,
): ChatItemPayload => ({
  role,
  content,
});

const insertChatItemWithQuery = async (
  queryFn: QueryFn,
  params: InsertChatItemParams,
): Promise<PersistedChatMessageItem> => {
  const result = await queryFn(INSERT_CHAT_ITEM_SQL, [
    params.sessionId,
    params.state,
    JSON.stringify(toChatItemPayload(params.role, params.content)),
  ]);

  return mapChatItemRow(
    requireChatItemRow(result.rows[0] as ChatItemRow | undefined, "insert"),
  );
};

const updateChatItemWithQuery = async (
  queryFn: QueryFn,
  params: UpdateChatMessageItemParams,
): Promise<PersistedChatMessageItem> => {
  const result = await queryFn(UPDATE_CHAT_ITEM_SQL, [
    params.itemId,
    JSON.stringify(toChatItemPayload("assistant", params.content)),
    params.state,
  ]);

  return mapChatItemRow(
    requireChatItemRow(result.rows[0] as ChatItemRow | undefined, "update"),
  );
};

const updateChatSessionStatusWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  status: ChatSessionRunState,
  heartbeatAt: Date | null,
): Promise<void> => {
  await queryFn(UPDATE_CHAT_SESSION_STATUS_SQL, [
    sessionId,
    status,
    heartbeatAt === null ? null : heartbeatAt.toISOString(),
  ]);
};

const selectLatestChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow | null> => {
  const result = await queryFn(SELECT_LATEST_SESSION_SQL, [userId, workspaceId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row ?? null;
};

const createChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(INSERT_SESSION_SQL, [userId, workspaceId]);
  return requireSessionRow(result.rows[0] as ChatSessionRow | undefined, "insert");
};

const resolveRequestedChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(SELECT_SESSION_SQL, [userId, workspaceId, sessionId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  if (row === undefined) {
    throw new ChatSessionNotFoundError(sessionId);
  }

  return row;
};

const resolveLatestOrCreateChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow> => {
  const latestSession = await selectLatestChatSessionWithQuery(queryFn, userId, workspaceId);
  if (latestSession !== null) {
    return latestSession;
  }

  return createChatSessionWithQuery(queryFn, userId, workspaceId);
};

export const getChatSessionId = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<string | null> => {
  const result = await queryAs(userId, workspaceId, SELECT_SESSION_SQL, [userId, workspaceId, sessionId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row?.session_id ?? null;
};

export const getLatestChatSessionId = async (
  userId: string,
  workspaceId: string,
): Promise<string | null> => {
  const result = await queryAs(userId, workspaceId, SELECT_LATEST_SESSION_SQL, [userId, workspaceId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row?.session_id ?? null;
};

export const createFreshChatSession = async (
  userId: string,
  workspaceId: string,
): Promise<string> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const row = await createChatSessionWithQuery(queryFn, userId, workspaceId);
    return row.session_id;
  });

export const listChatMessages = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ReadonlyArray<PersistedChatMessageItem>> => {
  const result = await queryAs(userId, workspaceId, LIST_CHAT_ITEMS_SQL, [sessionId]);
  return result.rows.map((row) => mapChatItemRow(row as ChatItemRow));
};

/**
 * Maps persisted chat items into the UI transcript shape stored and returned by the app.
 * This transcript remains the product source of truth for history, audit, and reset flows,
 * independent from the OpenAI-managed runtime conversation state.
 */
const mapPersistedMessagesToStoredMessages = (
  messages: ReadonlyArray<PersistedChatMessageItem>,
): ReadonlyArray<StoredMessage> =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    isError: message.isError,
    isStopped: message.isStopped,
  }));

/**
 * Builds the local message history kept by the app for attachment rehydration and local
 * context handling. This history is not replayed to the model for runtime memory; the next
 * model call uses only the current turn plus the stored OpenAI conversation ID.
 */
const buildLocalChatMessages = (
  messages: ReadonlyArray<PersistedChatMessageItem>,
): ReadonlyArray<ChatMessage> =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

export const getChatSessionSnapshot = async (
  userId: string,
  workspaceId: string,
  sessionId?: string,
): Promise<ChatSessionSnapshot> => {
  const sessionRow = sessionId === undefined
    ? await withUserContext(userId, workspaceId, async (queryFn) =>
      resolveLatestOrCreateChatSessionWithQuery(queryFn, userId, workspaceId))
    : await withUserContext(userId, workspaceId, async (queryFn) =>
      resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId));
  const messages = await listChatMessages(userId, workspaceId, sessionRow.session_id);

  return {
    ...mapSessionRow(sessionRow),
    messages: mapPersistedMessagesToStoredMessages(messages),
  };
};

/**
 * Persists the new user turn locally, creates the placeholder assistant item, and returns the
 * split runtime inputs used by the chat pipeline:
 * - `localMessages` for app-owned history, attachment rehydration, and debugging
 * - `turnInput` for the only user content sent to the model on this turn
 *
 * The OpenAI conversation is continued exclusively through `openai_conversation_id`, which is
 * loaded from the session row and later replaced after a successful completed run.
 */
export const prepareChatRun = async (
  userId: string,
  workspaceId: string,
  requestedSessionId: string | undefined,
  content: ReadonlyArray<ContentPart>,
): Promise<PreparedChatRun> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const sessionRow = requestedSessionId === undefined
      ? await resolveLatestOrCreateChatSessionWithQuery(queryFn, userId, workspaceId)
      : await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, requestedSessionId);

    const lockedSessionResult = await queryFn(SELECT_SESSION_FOR_UPDATE_SQL, [sessionRow.session_id]);
    const lockedSession = requireSessionRow(
      lockedSessionResult.rows[0] as ChatSessionRow | undefined,
      "lock",
    );

    if (lockedSession.status === "running") {
      throw new ChatSessionConflictError(sessionRow.session_id);
    }

    await insertChatItemWithQuery(queryFn, {
      sessionId: sessionRow.session_id,
      role: "user",
      state: "completed",
      content,
    });

    const persistedMessages = await queryFn(LIST_CHAT_ITEMS_SQL, [sessionRow.session_id]);
    const assistantItem = await insertChatItemWithQuery(queryFn, {
      sessionId: sessionRow.session_id,
      role: "assistant",
      state: "in_progress",
      content: [],
    });

    await updateChatSessionStatusWithQuery(queryFn, sessionRow.session_id, "running", new Date());

    return {
      sessionId: sessionRow.session_id,
      assistantItem,
      localMessages: buildLocalChatMessages(
        persistedMessages.rows.map((row) => mapChatItemRow(row as ChatItemRow)),
      ),
      turnInput: content,
      conversationId: lockedSession.openai_conversation_id,
    };
  });

export const updateAssistantMessageItem = async (
  userId: string,
  workspaceId: string,
  params: UpdateChatMessageItemParams,
): Promise<PersistedChatMessageItem> => {
  const result = await queryAs(userId, workspaceId, UPDATE_CHAT_ITEM_SQL, [
    params.itemId,
    JSON.stringify(toChatItemPayload("assistant", params.content)),
    params.state,
  ]);

  return mapChatItemRow(
    requireChatItemRow(result.rows[0] as ChatItemRow | undefined, "update"),
  );
};

export const touchChatSessionHeartbeat = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<void> => {
  await queryAs(userId, workspaceId, UPDATE_CHAT_SESSION_STATUS_SQL, [
    sessionId,
    "running",
    new Date().toISOString(),
  ]);
};

export const persistChatSessionConversationId = async (
  userId: string,
  workspaceId: string,
  params: PersistChatSessionConversationIdParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const lockedSessionResult = await queryFn(SELECT_SESSION_FOR_UPDATE_SQL, [params.sessionId]);
    const lockedSession = requireSessionRow(
      lockedSessionResult.rows[0] as ChatSessionRow | undefined,
      "lock",
    );

    if (lockedSession.openai_conversation_id === params.conversationId) {
      return;
    }

    if (lockedSession.openai_conversation_id !== null) {
      throw new Error(
        `Chat session conversationId mismatch for session ${params.sessionId}: stored=${lockedSession.openai_conversation_id} new=${params.conversationId}`,
      );
    }

    await queryFn(UPDATE_CHAT_SESSION_CONVERSATION_ID_SQL, [
      params.sessionId,
      params.conversationId,
    ]);
  });

/**
 * Finalizes the assistant message in the local transcript and persists the latest
 * `openai_conversation_id` on the chat session. The transcript remains the canonical product
 * history, while the conversation ID is the only runtime continuation token used with OpenAI.
 */
export const completeChatRun = async (
  userId: string,
  workspaceId: string,
  params: CompleteChatRunParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const updatedAssistant = await updateChatItemWithQuery(queryFn, {
      itemId: params.assistantItemId,
      content: params.assistantContent,
      state: "completed",
    });

    await queryFn(UPDATE_CHAT_SESSION_COMPLETION_SQL, [
      updatedAssistant.sessionId,
      params.conversationId,
    ]);
  });

export const persistAssistantTerminalError = async (
  userId: string,
  workspaceId: string,
  params: PersistAssistantTerminalErrorParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    if (params.assistantContent.length === 0) {
      await updateChatItemWithQuery(queryFn, {
        itemId: params.assistantItemId,
        content: [{ type: "text", text: params.errorMessage }],
        state: "error",
      });
    } else {
      await updateChatItemWithQuery(queryFn, {
        itemId: params.assistantItemId,
        content: params.assistantContent,
        state: "completed",
      });
      await insertChatItemWithQuery(queryFn, {
        sessionId: params.sessionId,
        role: "assistant",
        state: "error",
        content: [{ type: "text", text: params.errorMessage }],
      });
    }

    await updateChatSessionStatusWithQuery(queryFn, params.sessionId, params.sessionState, null);
  });

export const persistAssistantCancelled = async (
  userId: string,
  workspaceId: string,
  params: PersistAssistantCancelledParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    await updateChatItemWithQuery(queryFn, {
      itemId: params.assistantItemId,
      content: params.assistantContent,
      state: "cancelled",
    });

    await updateChatSessionStatusWithQuery(queryFn, params.sessionId, "idle", null);
  });

export const markChatSessionInterrupted = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  errorMessage: string,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const sessionRow = await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId);
    if (sessionRow.status !== "running") {
      return;
    }

    const messages = await queryFn(LIST_CHAT_ITEMS_SQL, [sessionId]);
    const persistedMessages = messages.rows.map((row) => mapChatItemRow(row as ChatItemRow));
    const lastMessage = persistedMessages[persistedMessages.length - 1];

    if (lastMessage !== undefined && lastMessage.role === "assistant" && lastMessage.state === "in_progress") {
      if (lastMessage.content.length === 0) {
        await updateChatItemWithQuery(queryFn, {
          itemId: lastMessage.itemId,
          content: [{ type: "text", text: errorMessage }],
          state: "error",
        });
      } else {
        await updateChatItemWithQuery(queryFn, {
          itemId: lastMessage.itemId,
          content: lastMessage.content,
          state: "completed",
        });
        await insertChatItemWithQuery(queryFn, {
          sessionId,
          role: "assistant",
          state: "error",
          content: [{ type: "text", text: errorMessage }],
        });
      }
    } else {
      await insertChatItemWithQuery(queryFn, {
        sessionId,
        role: "assistant",
        state: "error",
        content: [{ type: "text", text: errorMessage }],
      });
    }

    await updateChatSessionStatusWithQuery(queryFn, sessionId, "interrupted", null);
  });
