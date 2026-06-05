import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import type { ContentPart } from "@/server/chat/types";
import {
  parseMainContentInvalidationVersion,
  type ChatItemState,
  type InsertChatItemParams,
  type PersistedChatMessageItem,
  type RunScopedUpdateChatMessageItemAndInvalidateMainContentParams,
  type RunScopedUpdateChatMessageItemParams,
  type UpdateChatMessageItemAndInvalidateMainContentParams,
  type UpdateChatMessageItemParams,
} from "./shared";
import type { StoredOpenAIReplayItem } from "@/server/chat/openai/responses/replayItems";
import { lockActiveChatSessionRunWithQuery } from "./sessionStore";

type ChatItemPayload = Readonly<{
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
  openaiItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

type ChatItemRow = Readonly<{
  item_id: string;
  session_id: string;
  state: ChatItemState;
  payload: ChatItemPayload;
  created_at: string;
  updated_at: string;
}>;

type ChatItemWithInvalidationRow = ChatItemRow & Readonly<{
  main_content_invalidation_version: string;
}>;

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
    SET payload = $3::jsonb,
        state = $4,
        updated_at = now()
    WHERE item_id = $1
      AND session_id = $2
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

const UPDATE_CHAT_ITEM_AND_INVALIDATE_MAIN_CONTENT_SQL = `
  WITH updated_item AS (
    UPDATE public.chat_items
    SET payload = $3::jsonb,
        state = $4,
        updated_at = now()
    WHERE item_id = $1
      AND session_id = $2
    RETURNING item_id, session_id, state, payload, created_at, updated_at
  ),
  invalidated_session AS (
    UPDATE public.chat_sessions
    SET main_content_invalidation_version = main_content_invalidation_version + 1,
        updated_at = now()
    WHERE session_id = (SELECT session_id FROM updated_item)
    RETURNING main_content_invalidation_version
  )
  SELECT
    updated_item.item_id,
    updated_item.session_id,
    updated_item.state,
    updated_item.payload,
    updated_item.created_at,
    updated_item.updated_at,
    invalidated_session.main_content_invalidation_version
  FROM updated_item
  CROSS JOIN invalidated_session
`;

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
  assistantOpenAIItems?: ReadonlyArray<StoredOpenAIReplayItem>,
): ChatItemPayload => ({
  role,
  content,
  ...(role === "assistant" && assistantOpenAIItems !== undefined
    ? { openaiItems: assistantOpenAIItems }
    : {}),
});

export const mapChatItemRow = (row: ChatItemRow): PersistedChatMessageItem => ({
  itemId: row.item_id,
  sessionId: row.session_id,
  role: row.payload.role,
  content: row.payload.content,
  openaiItems: row.payload.role === "assistant" ? row.payload.openaiItems : undefined,
  state: row.state,
  isError: row.state === "error",
  isStopped: row.state === "cancelled",
  timestamp: new Date(row.created_at).getTime(),
  updatedAt: new Date(row.updated_at).getTime(),
});

export const listChatMessagesWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
): Promise<ReadonlyArray<PersistedChatMessageItem>> => {
  const result = await queryFn(LIST_CHAT_ITEMS_SQL, [sessionId]);
  return result.rows.map((row) => mapChatItemRow(row as ChatItemRow));
};

export const insertChatItemWithQuery = async (
  queryFn: QueryFn,
  params: InsertChatItemParams,
): Promise<PersistedChatMessageItem> => {
  const result = await queryFn(INSERT_CHAT_ITEM_SQL, [
    params.sessionId,
    params.state,
    JSON.stringify(toChatItemPayload(params.role, params.content, params.assistantOpenAIItems)),
  ]);

  return mapChatItemRow(
    requireChatItemRow(result.rows[0] as ChatItemRow | undefined, "insert"),
  );
};

export const updateChatItemWithQuery = async (
  queryFn: QueryFn,
  params: UpdateChatMessageItemParams,
): Promise<PersistedChatMessageItem> => {
  const result = await queryFn(UPDATE_CHAT_ITEM_SQL, [
    params.itemId,
    params.sessionId,
    JSON.stringify(toChatItemPayload("assistant", params.content, params.assistantOpenAIItems)),
    params.state,
  ]);

  return mapChatItemRow(
    requireChatItemRow(result.rows[0] as ChatItemRow | undefined, "update"),
  );
};

export const updateChatItemAndInvalidateMainContentWithQuery = async (
  queryFn: QueryFn,
  params: UpdateChatMessageItemAndInvalidateMainContentParams,
): Promise<Readonly<{
  item: PersistedChatMessageItem;
  mainContentInvalidationVersion: number;
}>> => {
  const result = await queryFn(UPDATE_CHAT_ITEM_AND_INVALIDATE_MAIN_CONTENT_SQL, [
    params.itemId,
    params.sessionId,
    JSON.stringify(toChatItemPayload("assistant", params.content, params.assistantOpenAIItems)),
    params.state,
  ]);

  const row = result.rows[0] as ChatItemWithInvalidationRow | undefined;
  if (row === undefined) {
    throw new Error("Chat item update+invalidate failed: query returned no row");
  }

  return {
    item: mapChatItemRow(row),
    mainContentInvalidationVersion: parseMainContentInvalidationVersion(
      row.main_content_invalidation_version,
      "update+invalidate",
    ),
  };
};

export const listChatMessages = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ReadonlyArray<PersistedChatMessageItem>> => {
  const result = await queryAs(userId, workspaceId, LIST_CHAT_ITEMS_SQL, [sessionId]);
  return result.rows.map((row) => mapChatItemRow(row as ChatItemRow));
};

export const updateAssistantMessageItem = async (
  userId: string,
  workspaceId: string,
  params: RunScopedUpdateChatMessageItemParams,
): Promise<PersistedChatMessageItem> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    updateAssistantMessageItemWithQuery(queryFn, params));

export const updateAssistantMessageItemWithQuery = async (
  queryFn: QueryFn,
  params: RunScopedUpdateChatMessageItemParams,
): Promise<PersistedChatMessageItem> => {
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "update assistant message",
  );
  return updateChatItemWithQuery(queryFn, params);
};

export const updateAssistantMessageItemAndInvalidateMainContentWithQuery = async (
  queryFn: QueryFn,
  params: RunScopedUpdateChatMessageItemAndInvalidateMainContentParams,
): Promise<Readonly<{
  item: PersistedChatMessageItem;
  mainContentInvalidationVersion: number;
}>> => {
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "update assistant message and invalidate main content",
  );
  return updateChatItemAndInvalidateMainContentWithQuery(queryFn, params);
};

export const updateAssistantMessageItemAndInvalidateMainContent = async (
  userId: string,
  workspaceId: string,
  params: RunScopedUpdateChatMessageItemAndInvalidateMainContentParams,
): Promise<number> => {
  const result = await withUserContext(userId, workspaceId, async (queryFn) =>
    updateAssistantMessageItemAndInvalidateMainContentWithQuery(queryFn, params));
  return result.mainContentInvalidationVersion;
};
