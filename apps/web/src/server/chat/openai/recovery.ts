import OpenAI from "openai";
import type { ConversationItem } from "openai/resources/conversations/items";
import type { ResponseInputItem } from "openai/resources/responses/responses";

export const QUERY_DATABASE_RECOVERY_TOOL_OUTPUT = "query_database was interrupted before its result was captured. The execution outcome is unknown. Check the current database state before deciding whether another write is needed.";
export const QUERY_DATABASE_RECOVERY_NOTE = "I recovered an earlier interrupted database step so we can keep using this conversation. Its result was lost, so I will re-check the current database state before relying on it.";

export type InterruptedQueryDatabaseRecovery = Readonly<{
  recoveredCallIds: ReadonlyArray<string>;
  recoveryNoteText: string | null;
  recoveryToolOutputText: string;
}>;

type RecoverInterruptedQueryDatabaseCallsDependencies = Readonly<{
  listConversationItems: (
    client: OpenAI,
    conversationId: string,
  ) => Promise<ReadonlyArray<ConversationItem>>;
  createConversationItems: (
    client: OpenAI,
    conversationId: string,
    items: ReadonlyArray<ResponseInputItem>,
  ) => Promise<void>;
}>;

const DEFAULT_RECOVER_INTERRUPTED_QUERY_DATABASE_CALLS_DEPENDENCIES: RecoverInterruptedQueryDatabaseCallsDependencies = {
  listConversationItems: async (
    client,
    conversationId,
  ): Promise<ReadonlyArray<ConversationItem>> => {
    const items: Array<ConversationItem> = [];
    for await (const item of client.conversations.items.list(conversationId)) {
      items.push(item);
    }
    return items;
  },
  createConversationItems: async (
    client,
    conversationId,
    items,
  ): Promise<void> => {
    await client.conversations.items.create(conversationId, { items: [...items] });
  },
};

const isQueryDatabaseFunctionCall = (
  item: ConversationItem,
): item is Extract<ConversationItem, { type: "function_call" }> =>
  item.type === "function_call"
  && item.name === "query_database"
  && typeof item.call_id === "string"
  && item.call_id.length > 0;

const isFunctionCallOutput = (
  item: ConversationItem,
): item is Extract<ConversationItem, { type: "function_call_output" }> =>
  item.type === "function_call_output"
  && typeof item.call_id === "string"
  && item.call_id.length > 0;

export const recoverInterruptedQueryDatabaseCallsWithDeps = async (
  client: OpenAI,
  conversationId: string | null,
  dependencies: RecoverInterruptedQueryDatabaseCallsDependencies,
): Promise<InterruptedQueryDatabaseRecovery> => {
  if (conversationId === null) {
    return {
      recoveredCallIds: [],
      recoveryNoteText: null,
      recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
    };
  }

  const conversationItems = await dependencies.listConversationItems(client, conversationId);
  const completedCallIds = new Set(
    conversationItems
      .filter(isFunctionCallOutput)
      .map((item) => item.call_id),
  );
  const seenPendingCallIds = new Set<string>();
  const recoveredCallIds = conversationItems
    .filter(isQueryDatabaseFunctionCall)
    .map((item) => item.call_id)
    .filter((callId) => {
      if (completedCallIds.has(callId) || seenPendingCallIds.has(callId)) {
        return false;
      }
      seenPendingCallIds.add(callId);
      return true;
    });

  if (recoveredCallIds.length === 0) {
    return {
      recoveredCallIds: [],
      recoveryNoteText: null,
      recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
    };
  }

  await dependencies.createConversationItems(
    client,
    conversationId,
    recoveredCallIds.map((callId) => ({
      type: "function_call_output",
      call_id: callId,
      output: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
    })),
  );

  return {
    recoveredCallIds,
    recoveryNoteText: QUERY_DATABASE_RECOVERY_NOTE,
    recoveryToolOutputText: QUERY_DATABASE_RECOVERY_TOOL_OUTPUT,
  };
};

export const recoverInterruptedQueryDatabaseCalls = async (
  client: OpenAI,
  conversationId: string | null,
): Promise<InterruptedQueryDatabaseRecovery> =>
  recoverInterruptedQueryDatabaseCallsWithDeps(
    client,
    conversationId,
    DEFAULT_RECOVER_INTERRUPTED_QUERY_DATABASE_CALLS_DEPENDENCIES,
  );
