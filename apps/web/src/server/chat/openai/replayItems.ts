import type OpenAI from "openai";
import type { ChatMessage } from "@/server/chat/types";

/**
 * Server-only subset of OpenAI conversation items we persist so later turns can
 * replay the model's native output back into the Responses API.
 *
 * This is intentionally broader than assistant messages alone: reasoning items,
 * function calls, and function call outputs also participate in manual
 * conversation state replay.
 */
export type StoredOpenAIReplayItem =
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseFunctionToolCall
  | OpenAI.Responses.ResponseInputItem.FunctionCallOutput;

export type ServerChatMessage = ChatMessage & Readonly<{
  /**
   * Opaque replay metadata used only by the server-side OpenAI integration.
   * The browser transcript continues to render from `content`.
   */
  openaiItems?: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export const toStoredOpenAIReplayItem = (
  item: OpenAI.Responses.ResponseOutputItem | OpenAI.Responses.ResponseInputItem.FunctionCallOutput,
): StoredOpenAIReplayItem => {
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
