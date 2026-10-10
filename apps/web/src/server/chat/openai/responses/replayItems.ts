import type OpenAI from "openai";
import type { ChatMessage } from "@/server/chat/types";

/**
 * Server-only subset of OpenAI conversation items we persist so later turns can
 * replay the model's native output back into the Responses API without relying
 * on provider-side item persistence.
 *
 * This is intentionally broader than assistant messages alone: reasoning items,
 * function calls, and function call outputs also participate in manual
 * conversation state replay.
 */
export type StoredOpenAIReplayReasoningItem = Readonly<{
  type: "reasoning";
  summary: OpenAI.Responses.ResponseReasoningItem["summary"];
  encrypted_content: string;
  status?: OpenAI.Responses.ResponseReasoningItem["status"];
}>;

export type StoredOpenAIReplayMessage = Readonly<{
  type: "message";
  role: "assistant";
  status: OpenAI.Responses.ResponseOutputMessage["status"];
  content: OpenAI.Responses.ResponseOutputMessage["content"];
  phase?: OpenAI.Responses.ResponseOutputMessage["phase"];
}>;

export type StoredOpenAIReplayFunctionToolCall = Readonly<{
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  status?: OpenAI.Responses.ResponseFunctionToolCall["status"];
}>;

export type StoredOpenAIReplayFunctionCallOutput = Readonly<{
  type: "function_call_output";
  call_id: string;
  output: OpenAI.Responses.ResponseInputItem.FunctionCallOutput["output"];
  status?: OpenAI.Responses.ResponseInputItem.FunctionCallOutput["status"];
}>;

/**
 * Opaque server-side summary of everything the model was sent ahead of it.
 * Replaying it in place of the turns it absorbed is the whole point of
 * compaction, so the older part of the transcript is never resent.
 */
export type StoredOpenAIReplayCompactionItem = Readonly<{
  type: "compaction";
  id: string;
  encrypted_content: string;
}>;

export type StoredOpenAIReplayItem =
  | StoredOpenAIReplayReasoningItem
  | StoredOpenAIReplayMessage
  | StoredOpenAIReplayFunctionToolCall
  | StoredOpenAIReplayFunctionCallOutput
  | StoredOpenAIReplayCompactionItem;

type LegacyStoredOpenAIReplayItem =
  | OpenAI.Responses.ResponseOutputMessage
  | OpenAI.Responses.ResponseReasoningItem
  | OpenAI.Responses.ResponseFunctionToolCall
  | OpenAI.Responses.ResponseInputItem.FunctionCallOutput
  | OpenAI.Responses.ResponseCompactionItem;

type NormalizeStoredOpenAIReplayItemsResult = Readonly<{
  items: ReadonlyArray<StoredOpenAIReplayItem>;
  droppedReasoningItems: number;
  droppedCompactionItems: number;
}>;

export type StoredOpenAIReplayItemsResult = Readonly<{
  items: ReadonlyArray<StoredOpenAIReplayItem>;
  droppedCompactionItems: number;
}>;

export type ChatCompactionBoundary = Readonly<{
  messageIndex: number;
  itemIndex: number;
}>;

/**
 * What the last model call of one completed assistant turn actually sent and
 * produced, as the provider counted it.
 *
 * `inputTokens` is that call's `usage.input_tokens`, so it covers the fixed
 * per-call reserve plus the stored messages the call replayed plus this turn's
 * earlier items - but not the items the call itself produced. `outputTokens` is
 * exactly those produced items, which the next turn replays, so the two
 * together size the stored history through this message and no further.
 * `replayedMessages` counts the stored messages the call replayed, back from the
 * newest, and is `0` when the run compacted its own context and replayed from
 * the compaction item instead of the stored history.
 */
export type ChatHistoryMeasurement = Readonly<{
  inputTokens: number;
  outputTokens: number;
  replayedMessages: number;
}>;

export type ServerChatMessage = ChatMessage & Readonly<{
  /**
   * Opaque replay metadata used only by the server-side OpenAI integration.
   * The browser transcript continues to render from `content`.
   */
  openaiItems?: ReadonlyArray<StoredOpenAIReplayItem>;
  /**
   * Absent for turns stored before measurements were recorded and for turns
   * that ended in an error or a cancellation, which are sized by estimate.
   */
  replayMeasurement?: ChatHistoryMeasurement;
}>;

const isMeasurementCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Validates one persisted measurement. The payload is untrusted JSONB, and a
 * `NaN` admitted here would propagate into every message weight and make window
 * selection throw on that session's every later turn, so an incomplete or
 * non-integer record is reported as absent and the message is sized by estimate
 * instead.
 */
export const parseChatHistoryMeasurement = (
  value: unknown,
): ChatHistoryMeasurement | undefined => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const { inputTokens, outputTokens, replayedMessages } = value as Readonly<{
    inputTokens?: unknown;
    outputTokens?: unknown;
    replayedMessages?: unknown;
  }>;
  if (
    !isMeasurementCount(inputTokens)
    || !isMeasurementCount(outputTokens)
    || !isMeasurementCount(replayedMessages)
  ) {
    return undefined;
  }

  return { inputTokens, outputTokens, replayedMessages };
};

const requireReplayCallId = (callId: string | null | undefined): string => {
  if (typeof callId !== "string" || callId.length === 0) {
    throw new Error("OpenAI function call output is missing call_id for stateless replay");
  }

  return callId;
};

/**
 * A compaction item is replayable only with both of its fields, and persisted
 * payloads are untrusted JSONB, so an incomplete one is reported as absent.
 */
const toReplayCompactionItem = (
  item: Readonly<{ id?: string | null; encrypted_content?: string | null }>,
): StoredOpenAIReplayCompactionItem | null => {
  if (typeof item.id !== "string" || item.id.length === 0) {
    return null;
  }
  if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    return null;
  }

  return {
    type: "compaction",
    id: item.id,
    encrypted_content: item.encrypted_content,
  };
};

export const toStoredOpenAIReplayItem = (
  item: OpenAI.Responses.ResponseOutputItem | OpenAI.Responses.ResponseInputItem.FunctionCallOutput,
): StoredOpenAIReplayItem => {
  if (item.type === "message") {
    return {
      type: "message",
      role: item.role,
      status: item.status,
      content: item.content,
      ...(item.phase !== undefined ? { phase: item.phase } : {}),
    };
  }

  if (item.type === "reasoning") {
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
      throw new Error("OpenAI reasoning item is missing encrypted_content for stateless replay");
    }

    return {
      type: "reasoning",
      summary: item.summary,
      encrypted_content: item.encrypted_content,
      ...(item.status !== undefined ? { status: item.status } : {}),
    };
  }

  if (item.type === "function_call") {
    return {
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      ...(item.status !== undefined ? { status: item.status } : {}),
    };
  }

  if (item.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: requireReplayCallId(item.call_id),
      output: item.output,
      ...(item.status !== undefined && item.status !== null ? { status: item.status } : {}),
    };
  }

  throw new Error(`Unsupported OpenAI response item for chat replay: ${item.type}`);
};

/**
 * Persists one response's output items. An unreplayable compaction item is
 * dropped rather than thrown on: the answer it belongs to has already streamed
 * to the browser, and without the item the next call just replays the history
 * the item would have stood for.
 */
export const toStoredOpenAIReplayItems = (
  items: ReadonlyArray<OpenAI.Responses.ResponseOutputItem>,
): StoredOpenAIReplayItemsResult => {
  const storedItems: Array<StoredOpenAIReplayItem> = [];
  let droppedCompactionItems = 0;

  for (const item of items) {
    if (item.type === "compaction") {
      const compactionItem = toReplayCompactionItem(item);
      if (compactionItem === null) {
        droppedCompactionItems += 1;
        continue;
      }
      storedItems.push(compactionItem);
      continue;
    }
    storedItems.push(toStoredOpenAIReplayItem(item));
  }

  return { items: storedItems, droppedCompactionItems };
};

const normalizeStoredOpenAIReplayItem = (
  item: StoredOpenAIReplayItem | LegacyStoredOpenAIReplayItem,
): StoredOpenAIReplayItem | null => {
  if (item.type === "message") {
    return {
      type: "message",
      role: item.role,
      status: item.status,
      content: item.content,
      ...(item.phase !== undefined ? { phase: item.phase } : {}),
    };
  }

  if (item.type === "reasoning") {
    if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
      return null;
    }

    return {
      type: "reasoning",
      summary: item.summary,
      encrypted_content: item.encrypted_content,
      ...(item.status !== undefined ? { status: item.status } : {}),
    };
  }

  if (item.type === "function_call") {
    return {
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
      ...(item.status !== undefined ? { status: item.status } : {}),
    };
  }

  if (item.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: requireReplayCallId(item.call_id),
      output: item.output,
      ...(item.status !== undefined && item.status !== null ? { status: item.status } : {}),
    };
  }

  if (item.type === "compaction") {
    return toReplayCompactionItem(item);
  }

  return null;
};

export const normalizeStoredOpenAIReplayItems = (
  items: ReadonlyArray<StoredOpenAIReplayItem | LegacyStoredOpenAIReplayItem>,
): NormalizeStoredOpenAIReplayItemsResult => {
  const normalizedItems: Array<StoredOpenAIReplayItem> = [];
  let droppedReasoningItems = 0;
  let droppedCompactionItems = 0;

  for (const item of items) {
    const normalizedItem = normalizeStoredOpenAIReplayItem(item);
    if (normalizedItem === null) {
      if (item.type === "reasoning") {
        droppedReasoningItems += 1;
      }
      if (item.type === "compaction") {
        droppedCompactionItems += 1;
      }
      continue;
    }
    normalizedItems.push(normalizedItem);
  }

  return {
    items: normalizedItems,
    droppedReasoningItems,
    droppedCompactionItems,
  };
};

export const toOpenAIResponseInputItem = (
  item: StoredOpenAIReplayItem,
): OpenAI.Responses.ResponseInputItem =>
  item as unknown as OpenAI.Responses.ResponseInputItem;

/**
 * Index of the newest replayable compaction item, or `-1`. One response can
 * carry two compaction items, so only the newest stands for the whole context
 * ahead of it.
 */
export const findLatestCompactionItemIndex = (
  items: ReadonlyArray<StoredOpenAIReplayItem>,
): number =>
  items.findLastIndex(
    (item) => item.type === "compaction" && toReplayCompactionItem(item) !== null,
  );

/**
 * Newest persisted compaction item of a session. Everything ahead of it is
 * already inside its encrypted summary, so replaying those turns would send the
 * same context twice. Only assistant turns replay from `openaiItems`, so only
 * they can carry the boundary.
 */
export const findLatestChatCompactionBoundary = (
  messages: ReadonlyArray<ServerChatMessage>,
): ChatCompactionBoundary | null => {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages.at(messageIndex);
    const items = message?.role === "assistant" ? message.openaiItems : undefined;
    if (items === undefined) {
      continue;
    }

    const itemIndex = findLatestCompactionItemIndex(items);
    if (itemIndex !== -1) {
      return { messageIndex, itemIndex };
    }
  }

  return null;
};

/**
 * Replays an item sequence from `startIndex`, the index of a compaction item.
 *
 * A `function_call_output` the loop appended after that item is not inside it,
 * so the cut restores its own `function_call` from before the cut directly in
 * front of it. An output whose call is absent from the whole sequence is
 * dropped: OpenAI answers that orphan with `400 No tool call found for function
 * call output`.
 */
export const replayItemsFromCompaction = (
  items: ReadonlyArray<StoredOpenAIReplayItem>,
  startIndex: number,
): ReadonlyArray<StoredOpenAIReplayItem> => {
  const keptItems = items.slice(startIndex);
  const keptCallIds = new Set<string>(
    keptItems.flatMap((item) => (item.type === "function_call" ? [item.call_id] : [])),
  );
  const cutCalls = new Map<string, StoredOpenAIReplayFunctionToolCall>(
    items.slice(0, startIndex).flatMap((
      item,
    ): ReadonlyArray<readonly [string, StoredOpenAIReplayFunctionToolCall]> => (
      item.type === "function_call" ? [[item.call_id, item]] : []
    )),
  );

  return keptItems.flatMap((item): ReadonlyArray<StoredOpenAIReplayItem> => {
    if (item.type !== "function_call_output" || keptCallIds.has(item.call_id)) {
      return [item];
    }

    const call = cutCalls.get(item.call_id);

    return call === undefined ? [] : [call, item];
  });
};
