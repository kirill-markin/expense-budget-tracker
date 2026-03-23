import type { ContentPart, ToolCallContentPart } from "@/server/chat/types";

export type StoredMessage = Readonly<{
  role: "user" | "assistant";
  content: ReadonlyArray<ContentPart>;
  timestamp: number;
  isError: boolean;
  isStopped: boolean;
}>;

export const appendAssistantTextContent = (
  content: ReadonlyArray<ContentPart>,
  text: string,
): ReadonlyArray<ContentPart> => {
  const lastPart = content.length > 0 ? content[content.length - 1] : undefined;
  if (lastPart !== undefined && lastPart.type === "text") {
    return [...content.slice(0, -1), { ...lastPart, text: lastPart.text + text }];
  }

  return [...content, { type: "text", text }];
};

export const upsertToolCallContent = (
  content: ReadonlyArray<ContentPart>,
  toolCall: ToolCallContentPart,
): ReadonlyArray<ContentPart> => {
  let found = false;
  const updatedContent = content.map((part) => {
    if (
      !found
      && part.type === "tool_call"
      && part.id !== undefined
      && toolCall.id !== undefined
      && part.id === toolCall.id
    ) {
      found = true;
      return {
        ...part,
        name: toolCall.name,
        status: toolCall.status,
        providerStatus: toolCall.providerStatus,
        input: toolCall.input,
        output: toolCall.output,
      };
    }
    return part;
  });

  if (found) {
    return updatedContent;
  }

  return [...content, toolCall];
};

export const applyAssistantError = (
  messages: ReadonlyArray<StoredMessage>,
  errorText: string,
  timestamp: number,
): ReadonlyArray<StoredMessage> => {
  if (messages.length === 0) {
    return messages;
  }

  const errorMessage: StoredMessage = {
    role: "assistant",
    content: [{ type: "text", text: errorText }],
    timestamp,
    isError: true,
    isStopped: false,
  };

  const last = messages[messages.length - 1];
  if (last.role !== "assistant") {
    return [...messages, errorMessage];
  }

  if (last.content.length === 0) {
    const updated: StoredMessage = {
      ...last,
      content: errorMessage.content,
      isError: true,
      isStopped: false,
    };
    return [...messages.slice(0, -1), updated];
  }

  return [...messages, errorMessage];
};
