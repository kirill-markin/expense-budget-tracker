type SerializedConversationState = Readonly<{
  conversationId?: string;
}>;

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
