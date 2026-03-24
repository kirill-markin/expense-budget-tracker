import OpenAI from "openai";
import {
  QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  recoverInterruptedQueryDatabaseCalls,
  type InterruptedQueryDatabaseRecovery,
} from "@/server/chat/openai/recovery";
import { persistRecoveredChatConversation } from "@/server/chat/store";

type RecoverInterruptedChatConversationParams = Readonly<{
  userId: string;
  workspaceId: string;
  sessionId: string;
  conversationId: string | null;
}>;

type RecoverInterruptedChatConversationDependencies = Readonly<{
  createClient: () => OpenAI;
  recoverInterruptedQueryDatabaseCalls: (
    client: OpenAI,
    conversationId: string | null,
  ) => Promise<InterruptedQueryDatabaseRecovery>;
  persistRecoveredChatConversation: typeof persistRecoveredChatConversation;
}>;

const DEFAULT_RECOVER_INTERRUPTED_CHAT_CONVERSATION_DEPENDENCIES: RecoverInterruptedChatConversationDependencies = {
  createClient: (): OpenAI => new OpenAI(),
  recoverInterruptedQueryDatabaseCalls,
  persistRecoveredChatConversation,
};

export const recoverInterruptedChatConversationWithDeps = async (
  params: RecoverInterruptedChatConversationParams,
  dependencies: RecoverInterruptedChatConversationDependencies,
): Promise<InterruptedQueryDatabaseRecovery> => {
  if (params.conversationId === null) {
    return {
      recoveredCallIds: [],
      recoveryNoteText: null,
      recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
    };
  }

  const client = dependencies.createClient();
  const recovery = await dependencies.recoverInterruptedQueryDatabaseCalls(
    client,
    params.conversationId,
  );

  if (recovery.recoveredCallIds.length === 0 || recovery.recoveryNoteText === null) {
    return recovery;
  }

  await dependencies.persistRecoveredChatConversation(
    params.userId,
    params.workspaceId,
    {
      sessionId: params.sessionId,
      recoveredCallIds: recovery.recoveredCallIds,
      recoveryNoteText: recovery.recoveryNoteText,
      recoveryToolOutputText: recovery.recoveryToolOutputText,
    },
  );

  return recovery;
};

export const recoverInterruptedChatConversation = async (
  params: RecoverInterruptedChatConversationParams,
): Promise<InterruptedQueryDatabaseRecovery> =>
  recoverInterruptedChatConversationWithDeps(
    params,
    DEFAULT_RECOVER_INTERRUPTED_CHAT_CONVERSATION_DEPENDENCIES,
  );
