import OpenAI from "openai";
import {
  INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  recoverInterruptedFunctionCalls,
  type InterruptedFunctionCallRecovery,
} from "@/server/chat/openai/recovery";
import { persistRecoveredChatConversation } from "@/server/chat/store";
import { log } from "@/server/logger";

type RecoverInterruptedChatConversationParams = Readonly<{
  userId: string;
  workspaceId: string;
  sessionId: string;
  conversationId: string | null;
}>;

type RecoverInterruptedChatConversationDependencies = Readonly<{
  createClient: () => OpenAI;
  recoverInterruptedFunctionCalls: (
    client: OpenAI,
    conversationId: string | null,
  ) => Promise<InterruptedFunctionCallRecovery>;
  persistRecoveredChatConversation: typeof persistRecoveredChatConversation;
}>;

const DEFAULT_RECOVER_INTERRUPTED_CHAT_CONVERSATION_DEPENDENCIES: RecoverInterruptedChatConversationDependencies = {
  createClient: (): OpenAI => new OpenAI(),
  recoverInterruptedFunctionCalls,
  persistRecoveredChatConversation,
};

export const recoverInterruptedChatConversationWithDeps = async (
  params: RecoverInterruptedChatConversationParams,
  dependencies: RecoverInterruptedChatConversationDependencies,
): Promise<InterruptedFunctionCallRecovery> => {
  if (params.conversationId === null) {
    return {
      recoveredCalls: [],
      recoveryNoteText: null,
      recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    };
  }

  const client = dependencies.createClient();
  const recovery = await dependencies.recoverInterruptedFunctionCalls(
    client,
    params.conversationId,
  );

  if (recovery.recoveredCalls.length === 0 || recovery.recoveryNoteText === null) {
    return recovery;
  }

  log({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "stream",
    error: `Recovered ${String(recovery.recoveredCalls.length)} interrupted function call(s) without durable outputs: ${recovery.recoveredCalls.map((call) => `${call.name}:${call.callId}`).join(", ")}`,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });

  await dependencies.persistRecoveredChatConversation(
    params.userId,
    params.workspaceId,
    {
      sessionId: params.sessionId,
      recoveredCalls: recovery.recoveredCalls,
      recoveryNoteText: recovery.recoveryNoteText,
      recoveryToolOutputText: recovery.recoveryToolOutputText,
    },
  );

  return recovery;
};

export const recoverInterruptedChatConversation = async (
  params: RecoverInterruptedChatConversationParams,
): Promise<InterruptedFunctionCallRecovery> =>
  recoverInterruptedChatConversationWithDeps(
    params,
    DEFAULT_RECOVER_INTERRUPTED_CHAT_CONVERSATION_DEPENDENCIES,
  );
