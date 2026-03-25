import type OpenAI from "openai";
import type { ChatMessage } from "@/server/chat/types";

export type StoredOpenAIResponseItem =
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseFunctionToolCall
  | OpenAI.Responses.ResponseInputItem.FunctionCallOutput;

export type ServerChatMessage = ChatMessage & Readonly<{
  openaiItems?: ReadonlyArray<StoredOpenAIResponseItem>;
}>;

export const toStoredOpenAIResponseItem = (
  item: OpenAI.Responses.ResponseOutputItem | OpenAI.Responses.ResponseInputItem.FunctionCallOutput,
): StoredOpenAIResponseItem => {
  if (
    item.type === "message"
    || item.type === "reasoning"
    || item.type === "function_call"
    || item.type === "function_call_output"
  ) {
    return item;
  }

  throw new Error(`Unsupported OpenAI response item for chat replay: ${item.type}`);
};
