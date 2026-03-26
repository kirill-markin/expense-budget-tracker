import { finalizePendingToolCallContent } from "@/lib/chatHistory";
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import type { ContentPart } from "@/server/chat/types";
import {
  ChatSessionConflictError,
  FAILED_TOOL_CALL_OUTPUT,
  INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
  INTERRUPTED_TOOL_CALL_OUTPUT,
  STOPPED_BY_USER_TOOL_OUTPUT,
  type CompleteChatRunParams,
  type PersistAssistantCancelledParams,
  type PersistedChatMessageItem,
  type PersistAssistantTerminalErrorParams,
  type PreparedChatRun,
  type UserStoppedChatRunUpdatePlan,
} from "./shared";
import {
  insertChatItemWithQuery,
  listChatMessagesWithQuery,
  updateChatItemWithQuery,
} from "./messageStore";
import { buildLocalChatMessages } from "./snapshotStore";
import {
  lockChatSessionWithQuery,
  resolveLatestOrCreateChatSessionWithQuery,
  resolveRequestedChatSessionWithQuery,
  updateChatSessionStatusWithQuery,
} from "./sessionStore";

export const buildUserStoppedAssistantContent = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<ContentPart> =>
  content.map((part) => {
    if (part.type !== "tool_call" || part.status !== "started") {
      return part;
    }

    return {
      ...part,
      status: "completed",
      providerStatus: INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
      output: part.output ?? STOPPED_BY_USER_TOOL_OUTPUT,
    };
  });

export const buildUserStoppedChatRunUpdatePlan = (
  messages: ReadonlyArray<PersistedChatMessageItem>,
): UserStoppedChatRunUpdatePlan => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || message.state !== "in_progress") {
      continue;
    }

    return {
      assistantItem: message,
      assistantContent: buildUserStoppedAssistantContent(message.content),
      assistantOpenAIItems: message.openaiItems ?? null,
      sessionState: "idle",
    };
  }

  return {
    assistantItem: null,
    assistantContent: null,
    assistantOpenAIItems: null,
    sessionState: "idle",
  };
};

export const prepareChatRunWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  requestedSessionId: string | undefined,
  content: ReadonlyArray<ContentPart>,
): Promise<PreparedChatRun> => {
  const sessionRow = requestedSessionId === undefined
    ? await resolveLatestOrCreateChatSessionWithQuery(queryFn, userId, workspaceId)
    : await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, requestedSessionId);

  const lockedSession = await lockChatSessionWithQuery(queryFn, sessionRow.session_id);
  if (lockedSession.status === "running") {
    throw new ChatSessionConflictError(sessionRow.session_id);
  }

  await insertChatItemWithQuery(queryFn, {
    sessionId: sessionRow.session_id,
    role: "user",
    state: "completed",
    content,
  });

  const persistedMessages = await listChatMessagesWithQuery(queryFn, sessionRow.session_id);
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
    localMessages: buildLocalChatMessages(persistedMessages),
    turnInput: content,
  };
};

export const prepareChatRun = async (
  userId: string,
  workspaceId: string,
  requestedSessionId: string | undefined,
  content: ReadonlyArray<ContentPart>,
): Promise<PreparedChatRun> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    prepareChatRunWithQuery(queryFn, userId, workspaceId, requestedSessionId, content));

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
      assistantOpenAIItems: params.assistantOpenAIItems,
    });

    await updateChatSessionStatusWithQuery(queryFn, updatedAssistant.sessionId, "idle", null);
  });

export const persistAssistantTerminalErrorWithQuery = async (
  queryFn: QueryFn,
  params: PersistAssistantTerminalErrorParams,
): Promise<void> => {
  const finalizedAssistantContent = finalizePendingToolCallContent(
    params.assistantContent,
    INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
    FAILED_TOOL_CALL_OUTPUT,
  );

  if (finalizedAssistantContent.length === 0) {
    await updateChatItemWithQuery(queryFn, {
      itemId: params.assistantItemId,
      content: [{ type: "text", text: params.errorMessage }],
      state: "error",
      assistantOpenAIItems: params.assistantOpenAIItems,
    });
  } else {
    await updateChatItemWithQuery(queryFn, {
      itemId: params.assistantItemId,
      content: finalizedAssistantContent,
      state: "completed",
      assistantOpenAIItems: params.assistantOpenAIItems,
    });
    await insertChatItemWithQuery(queryFn, {
      sessionId: params.sessionId,
      role: "assistant",
      state: "error",
      content: [{ type: "text", text: params.errorMessage }],
    });
  }

  await updateChatSessionStatusWithQuery(queryFn, params.sessionId, params.sessionState, null);
};

export const persistAssistantTerminalError = async (
  userId: string,
  workspaceId: string,
  params: PersistAssistantTerminalErrorParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    persistAssistantTerminalErrorWithQuery(queryFn, params));

export const persistAssistantCancelledWithQuery = async (
  queryFn: QueryFn,
  params: PersistAssistantCancelledParams,
): Promise<void> => {
  await updateChatItemWithQuery(queryFn, {
    itemId: params.assistantItemId,
    content: buildUserStoppedAssistantContent(params.assistantContent),
    state: "cancelled",
    assistantOpenAIItems: params.assistantOpenAIItems,
  });

  await updateChatSessionStatusWithQuery(queryFn, params.sessionId, "idle", null);
};

export const persistAssistantCancelled = async (
  userId: string,
  workspaceId: string,
  params: PersistAssistantCancelledParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    persistAssistantCancelledWithQuery(queryFn, params));

export const cancelActiveChatRunByUserWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> => {
  await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId);

  const lockedSession = await lockChatSessionWithQuery(queryFn, sessionId);
  if (lockedSession.status !== "running") {
    return false;
  }

  const messages = await listChatMessagesWithQuery(queryFn, sessionId);
  const updatePlan = buildUserStoppedChatRunUpdatePlan(messages);

  if (updatePlan.assistantItem !== null && updatePlan.assistantContent !== null) {
    await updateChatItemWithQuery(queryFn, {
      itemId: updatePlan.assistantItem.itemId,
      content: updatePlan.assistantContent,
      state: "cancelled",
      assistantOpenAIItems: updatePlan.assistantOpenAIItems ?? undefined,
    });
  }

  await updateChatSessionStatusWithQuery(queryFn, sessionId, updatePlan.sessionState, null);
  return true;
};

export const cancelActiveChatRunByUser = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<boolean> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    cancelActiveChatRunByUserWithQuery(queryFn, userId, workspaceId, sessionId));

export const markChatSessionInterruptedWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string,
  errorMessage: string,
): Promise<void> => {
  const sessionRow = await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId);
  if (sessionRow.status !== "running") {
    return;
  }

  const persistedMessages = await listChatMessagesWithQuery(queryFn, sessionId);
  const lastMessage = persistedMessages[persistedMessages.length - 1];

  if (lastMessage !== undefined && lastMessage.role === "assistant" && lastMessage.state === "in_progress") {
    const finalizedAssistantContent = finalizePendingToolCallContent(
      lastMessage.content,
      INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
      INTERRUPTED_TOOL_CALL_OUTPUT,
    );

    if (lastMessage.content.length === 0) {
      await updateChatItemWithQuery(queryFn, {
        itemId: lastMessage.itemId,
        content: [{ type: "text", text: errorMessage }],
        state: "error",
      });
    } else {
      await updateChatItemWithQuery(queryFn, {
        itemId: lastMessage.itemId,
        content: finalizedAssistantContent,
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
};

export const markChatSessionInterrupted = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  errorMessage: string,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    markChatSessionInterruptedWithQuery(queryFn, userId, workspaceId, sessionId, errorMessage));
