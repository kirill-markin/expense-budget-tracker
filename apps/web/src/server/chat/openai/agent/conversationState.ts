type SerializedConversationState = Readonly<{
  conversationId?: string;
}>;

/**
 * Extracts the OpenAI-managed conversation identifier from the completed SDK run state.
 * The app stores this value on the local chat session and uses it as the only runtime
 * continuation pointer for subsequent turns.
 */
export const extractConversationId = (
  state: Readonly<{
    toJSON: () => unknown;
  }>,
): string | null => {
  const serializedState = state.toJSON() as SerializedConversationState;
  return typeof serializedState.conversationId === "string" && serializedState.conversationId.length > 0
    ? serializedState.conversationId
    : null;
};
