import { randomUUID } from "node:crypto";
import { finalizePendingToolCallContent } from "@/lib/chatHistory";
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import type { ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
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
  type UserCancelChatRunResult,
  type UserStoppedChatRunUpdatePlan,
} from "./shared";
import {
  insertChatItemWithQuery,
  listChatMessagesWithQuery,
  updateChatItemWithQuery,
} from "./messageStore";
import { buildLocalChatMessages } from "./snapshotStore";
import {
  completeChatSessionRunWithQuery,
  lockActiveChatSessionRunWithQuery,
  lockChatSessionWithQuery,
  lockRequestedChatSessionWithQuery,
  requireActiveRunId,
  resolveLatestOrCreateChatSessionWithQuery,
  resolveRequestedChatSessionWithQuery,
  startChatSessionRunWithQuery,
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

  const activeRunId = randomUUID();
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

  await startChatSessionRunWithQuery(queryFn, sessionRow.session_id, activeRunId, new Date());

  return {
    sessionId: sessionRow.session_id,
    activeRunId,
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

export const completeChatRunWithQuery = async (
  queryFn: QueryFn,
  params: CompleteChatRunParams,
): Promise<void> => {
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "complete chat run",
  );
  await updateChatItemWithQuery(queryFn, {
    sessionId: params.sessionId,
    itemId: params.assistantItemId,
    content: params.assistantContent,
    state: "completed",
    assistantOpenAIItems: params.assistantOpenAIItems,
  });

  await completeChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "idle",
  );
};

export const completeChatRun = async (
  userId: string,
  workspaceId: string,
  params: CompleteChatRunParams,
): Promise<void> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    completeChatRunWithQuery(queryFn, params));

export const persistAssistantTerminalErrorWithQuery = async (
  queryFn: QueryFn,
  params: PersistAssistantTerminalErrorParams,
): Promise<void> => {
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "persist assistant terminal error",
  );

  const finalizedAssistantContent = finalizePendingToolCallContent(
    params.assistantContent,
    INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
    FAILED_TOOL_CALL_OUTPUT,
  );

  if (finalizedAssistantContent.length === 0) {
    await updateChatItemWithQuery(queryFn, {
      sessionId: params.sessionId,
      itemId: params.assistantItemId,
      content: [{ type: "text", text: params.errorMessage }],
      state: "error",
      assistantOpenAIItems: params.assistantOpenAIItems,
    });
  } else {
    await updateChatItemWithQuery(queryFn, {
      sessionId: params.sessionId,
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

  await completeChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    params.sessionState,
  );
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
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "persist assistant cancellation",
  );

  await updateChatItemWithQuery(queryFn, {
    sessionId: params.sessionId,
    itemId: params.assistantItemId,
    content: buildUserStoppedAssistantContent(params.assistantContent),
    state: "cancelled",
    assistantOpenAIItems: params.assistantOpenAIItems,
  });

  await completeChatSessionRunWithQuery(
    queryFn,
    params.sessionId,
    params.activeRunId,
    "idle",
  );
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
  expectedActiveRunId: string,
): Promise<UserCancelChatRunResult> => {
  await resolveRequestedChatSessionWithQuery(queryFn, userId, workspaceId, sessionId);

  const lockedSession = await lockChatSessionWithQuery(queryFn, sessionId);
  if (lockedSession.status !== "running") {
    return "not_running";
  }
  const activeRunId = requireActiveRunId(lockedSession, "cancel active run");
  if (activeRunId !== expectedActiveRunId) {
    return "run_changed";
  }

  const messages = await listChatMessagesWithQuery(queryFn, sessionId);
  const updatePlan = buildUserStoppedChatRunUpdatePlan(messages);

  if (updatePlan.assistantItem !== null && updatePlan.assistantContent !== null) {
    await updateChatItemWithQuery(queryFn, {
      sessionId,
      itemId: updatePlan.assistantItem.itemId,
      content: updatePlan.assistantContent,
      state: "cancelled",
      assistantOpenAIItems: updatePlan.assistantOpenAIItems ?? undefined,
    });
  }

  await completeChatSessionRunWithQuery(
    queryFn,
    sessionId,
    expectedActiveRunId,
    updatePlan.sessionState,
  );
  return "cancelled";
};

export const cancelActiveChatRunByUser = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
  expectedActiveRunId: string,
): Promise<UserCancelChatRunResult> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    cancelActiveChatRunByUserWithQuery(queryFn, userId, workspaceId, sessionId, expectedActiveRunId));

export type StaleChatSessionRecoveryResult =
  | "interrupted"
  | "completed_recovered"
  | "not_running"
  | "run_changed";

export type RecoverStaleChatSessionParams = Readonly<{
  sessionId: string;
  expectedActiveRunId: string;
  errorMessage: string;
}>;

export const recoverStaleChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  params: RecoverStaleChatSessionParams,
): Promise<StaleChatSessionRecoveryResult> => {
  const sessionRow = await lockRequestedChatSessionWithQuery(
    queryFn,
    userId,
    workspaceId,
    params.sessionId,
  );
  if (sessionRow.status !== "running") {
    return "not_running";
  }

  if (sessionRow.active_run_id !== params.expectedActiveRunId) {
    return "run_changed";
  }

  const persistedMessages = await listChatMessagesWithQuery(queryFn, params.sessionId);
  const lastMessage = persistedMessages[persistedMessages.length - 1];

  if (lastMessage !== undefined && lastMessage.role === "assistant" && lastMessage.state === "in_progress") {
    const finalizedAssistantContent = finalizePendingToolCallContent(
      lastMessage.content,
      INCOMPLETE_TOOL_CALL_PROVIDER_STATUS,
      INTERRUPTED_TOOL_CALL_OUTPUT,
    );

    if (lastMessage.content.length === 0) {
      await updateChatItemWithQuery(queryFn, {
        sessionId: params.sessionId,
        itemId: lastMessage.itemId,
        content: [{ type: "text", text: params.errorMessage }],
        state: "error",
      });
    } else {
      await updateChatItemWithQuery(queryFn, {
        sessionId: params.sessionId,
        itemId: lastMessage.itemId,
        content: finalizedAssistantContent,
        state: "completed",
      });
      await insertChatItemWithQuery(queryFn, {
        sessionId: params.sessionId,
        role: "assistant",
        state: "error",
        content: [{ type: "text", text: params.errorMessage }],
      });
    }
    await completeChatSessionRunWithQuery(
      queryFn,
      params.sessionId,
      params.expectedActiveRunId,
      "interrupted",
    );
    return "interrupted";
  } else {
    await completeChatSessionRunWithQuery(
      queryFn,
      params.sessionId,
      params.expectedActiveRunId,
      "idle",
    );
    log({
      domain: "chat",
      action: "stale_completed_run_recovered",
      sessionId: params.sessionId,
      userId,
      workspaceId,
      activeRunId: params.expectedActiveRunId,
      lastMessageRole: lastMessage?.role,
      lastMessageState: lastMessage?.state,
    });
    return "completed_recovered";
  }
};

export const recoverStaleChatSession = async (
  userId: string,
  workspaceId: string,
  params: RecoverStaleChatSessionParams,
): Promise<StaleChatSessionRecoveryResult> =>
  withUserContext(userId, workspaceId, async (queryFn) =>
    recoverStaleChatSessionWithQuery(queryFn, userId, workspaceId, params));

export const markChatSessionInterruptedWithQuery = recoverStaleChatSessionWithQuery;
export const markChatSessionInterrupted = recoverStaleChatSession;
