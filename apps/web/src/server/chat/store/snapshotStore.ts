import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import {
  type ChatSessionSnapshot,
  type PersistedChatMessageItem,
} from "./shared";
import {
  lockChatSessionForSnapshotWithQuery,
  mapSessionRow,
  resolveLatestOrCreateChatSessionWithQuery,
  resolveRequestedChatSessionWithQuery,
} from "./sessionStore";
import { listChatMessagesWithQuery } from "./messageStore";

export const buildLocalChatMessages = (
  messages: ReadonlyArray<PersistedChatMessageItem>,
): ReadonlyArray<ServerChatMessage> =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.openaiItems !== undefined ? { openaiItems: message.openaiItems } : {}),
  }));

export const getChatSessionSnapshot = async (
  userId: string,
  workspaceId: string,
  sessionId?: string,
): Promise<ChatSessionSnapshot> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    getChatSessionSnapshotWithQuery(
      queryFn,
      userId,
      workspaceId,
      sessionId,
    ));

export const getChatSessionSnapshotWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string | undefined,
): Promise<ChatSessionSnapshot> => {
  const sessionRow = sessionId === undefined
    ? await resolveLatestOrCreateChatSessionWithQuery(
      queryFn,
      userId,
      workspaceId,
    )
    : await resolveRequestedChatSessionWithQuery(
      queryFn,
      userId,
      workspaceId,
      sessionId,
    );
  const lockedSessionRow = await lockChatSessionForSnapshotWithQuery(
    queryFn,
    sessionRow.session_id,
  );
  const messages = await listChatMessagesWithQuery(
    queryFn,
    lockedSessionRow.session_id,
  );

  return {
    ...mapSessionRow(lockedSessionRow),
    messages,
  };
};
