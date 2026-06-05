import { withUserContext } from "@/server/db";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import {
  type ChatSessionSnapshot,
  type PersistedChatMessageItem,
} from "./shared";
import {
  mapSessionRow,
  resolveLatestOrCreateChatSessionWithQuery,
  resolveRequestedChatSessionWithQuery,
} from "./sessionStore";
import { listChatMessages } from "./messageStore";

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
): Promise<ChatSessionSnapshot> => {
  const sessionRow = sessionId === undefined
    ? await withUserContext(userId, workspaceId, async (queryFn) =>
      resolveLatestOrCreateChatSessionWithQuery(queryFn, userId, workspaceId))
    : await withUserContext(userId, workspaceId, async (queryFn) =>
      resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId));
  const messages = await listChatMessages(userId, workspaceId, sessionRow.session_id);

  return {
    ...mapSessionRow(sessionRow),
    messages,
  };
};
