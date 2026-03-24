import OpenAI from "openai";
import type { ConversationItem } from "openai/resources/conversations/items";

export const INTERRUPTED_FUNCTION_CALL_RECOVERY_NOTE = "Recovered interrupted tool calls that were missing durable outputs in the stored OpenAI conversation.";
export const INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT = "Interrupted before output was captured. The execution outcome is unknown. Inspect the current state before retrying.";

export type RecoveredFunctionCall = Readonly<{
  callId: string;
  name: string;
}>;

export type InterruptedFunctionCallRecovery = Readonly<{
  recoveredCalls: ReadonlyArray<RecoveredFunctionCall>;
  recoveryNoteText: string | null;
  recoveryToolOutputText: string;
}>;

type RecoverInterruptedFunctionCallsDependencies = Readonly<{
  listConversationItems: (
    client: OpenAI,
    conversationId: string,
  ) => Promise<ReadonlyArray<ConversationItem>>;
  createConversationItems: (
    client: OpenAI,
    conversationId: string,
    items: ReadonlyArray<Extract<ConversationItem, { type: "function_call_output" }>>,
  ) => Promise<void>;
}>;

const DEFAULT_RECOVER_INTERRUPTED_FUNCTION_CALLS_DEPENDENCIES: RecoverInterruptedFunctionCallsDependencies = {
  listConversationItems: async (
    client,
    conversationId,
  ): Promise<ReadonlyArray<ConversationItem>> => {
    const items = await client.conversations.items.list(conversationId, {
      order: "asc",
    });
    return items.data;
  },
  createConversationItems: async (
    client,
    conversationId,
    items,
  ): Promise<void> => {
    await client.conversations.items.create(conversationId, { items: [...items] });
  },
};

const isFunctionCall = (
  item: ConversationItem,
): item is Extract<ConversationItem, { type: "function_call" }> =>
  item.type === "function_call"
  && typeof item.call_id === "string"
  && item.call_id.length > 0
  && typeof item.name === "string"
  && item.name.length > 0;

const isFunctionCallOutput = (
  item: ConversationItem,
): item is Extract<ConversationItem, { type: "function_call_output" }> =>
  item.type === "function_call_output"
  && typeof item.call_id === "string"
  && item.call_id.length > 0;

export const recoverInterruptedFunctionCallsWithDeps = async (
  client: OpenAI,
  conversationId: string | null,
  dependencies: RecoverInterruptedFunctionCallsDependencies,
): Promise<InterruptedFunctionCallRecovery> => {
  if (conversationId === null) {
    return {
      recoveredCalls: [],
      recoveryNoteText: null,
      recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    };
  }

  const conversationItems = await dependencies.listConversationItems(client, conversationId);
  const completedCallIds = new Set(
    conversationItems
      .filter(isFunctionCallOutput)
      .map((item) => item.call_id),
  );
  const seenPendingCallIds = new Set<string>();
  const recoveredCalls = conversationItems
    .filter(isFunctionCall)
    .filter((item) => {
      if (completedCallIds.has(item.call_id) || seenPendingCallIds.has(item.call_id)) {
        return false;
      }
      seenPendingCallIds.add(item.call_id);
      return true;
    })
    .map((item) => ({
      callId: item.call_id,
      name: item.name,
    }));

  if (recoveredCalls.length === 0) {
    return {
      recoveredCalls: [],
      recoveryNoteText: null,
      recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    };
  }

  await dependencies.createConversationItems(
    client,
    conversationId,
    recoveredCalls.map((call) => ({
      type: "function_call_output",
      call_id: call.callId,
      output: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
    })),
  );

  return {
    recoveredCalls,
    recoveryNoteText: INTERRUPTED_FUNCTION_CALL_RECOVERY_NOTE,
    recoveryToolOutputText: INTERRUPTED_FUNCTION_CALL_RECOVERY_OUTPUT,
  };
};

export const recoverInterruptedFunctionCalls = async (
  client: OpenAI,
  conversationId: string | null,
): Promise<InterruptedFunctionCallRecovery> =>
  recoverInterruptedFunctionCallsWithDeps(
    client,
    conversationId,
    DEFAULT_RECOVER_INTERRUPTED_FUNCTION_CALLS_DEPENDENCIES,
  );
