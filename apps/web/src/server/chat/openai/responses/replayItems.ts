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

/**
 * Where the bytes of one `view_file` result are read from, stored instead of
 * those bytes.
 *
 * A native `input_image` costs around 1,600 tokens and the same image as base64
 * text inside a tool result costs 15,000-25,000, so the bytes must reach the
 * model as a native part and must never be persisted as one: a stored data URL
 * would also be what the history window then weighs the turn by. The reference
 * is what the row holds, and prompt assembly reads the file again to rebuild the
 * part.
 *
 * The digest is the row's own at view time. A /work path the model has since
 * rewritten carries a different one, so the rebuild can tell "the same file" from
 * "another file under the same name" without reading either body.
 */
export type StoredChatFileViewReference = Readonly<{
  fileId: string;
  path: string;
  sha256: string;
  /** PDF page this reference renders, or null for the whole file as an image. */
  page: number | null;
}>;

export type StoredOpenAIReplayFunctionCallOutput = Readonly<{
  type: "function_call_output";
  call_id: string;
  output: OpenAI.Responses.ResponseInputItem.FunctionCallOutput["output"];
  status?: OpenAI.Responses.ResponseInputItem.FunctionCallOutput["status"];
  /**
   * Set by `view_file` alone. While the run that produced it is still going,
   * `output` carries the native part beside its text; everything persisted has
   * been through `toPersistedOpenAIReplayItems`, which keeps the text and this
   * reference and drops the bytes.
   */
  chatFileView?: StoredChatFileViewReference;
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

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * One persisted view reference, or null when it is not replayable.
 *
 * The payload is untrusted JSONB, and an incomplete reference would be read as a
 * file to look up and then answered against a path or a digest that is not a
 * string. Reported as absent instead: the stored text part still replays, which
 * is what the item says happened, minus the bytes.
 */
const toChatFileViewReference = (
  value: unknown,
): StoredChatFileViewReference | null => {
  if (value === null || typeof value !== "object") {
    return null;
  }

  const { fileId, path, sha256, page } = value as Readonly<{
    fileId?: unknown;
    path?: unknown;
    sha256?: unknown;
    page?: unknown;
  }>;
  if (!isNonEmptyString(fileId) || !isNonEmptyString(path) || !isNonEmptyString(sha256)) {
    return null;
  }
  if (page !== null && !(typeof page === "number" && Number.isInteger(page))) {
    return null;
  }

  return { fileId, path, sha256, page };
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
    const reference = toChatFileViewReference(
      "chatFileView" in item ? item.chatFileView : null,
    );
    return {
      type: "function_call_output",
      call_id: requireReplayCallId(item.call_id),
      output: item.output,
      ...(item.status !== undefined && item.status !== null ? { status: item.status } : {}),
      ...(reference === null ? {} : { chatFileView: reference }),
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

/**
 * One stored item as a request may carry it.
 *
 * A cast, because every member of StoredOpenAIReplayItem is a subset of the
 * provider type it stands for - except `chatFileView`, which is this app's own
 * and is dropped here. It is where the bytes of a `view_file` result are read
 * from: a file id, a path and a digest of the user's file, which the provider has
 * no use for and must not be sent. Dropped in the cast rather than at each call
 * site, so no caller has to remember to.
 */
export const toOpenAIResponseInputItem = (
  item: StoredOpenAIReplayItem,
): OpenAI.Responses.ResponseInputItem => {
  if (item.type !== "function_call_output" || item.chatFileView === undefined) {
    return item as unknown as OpenAI.Responses.ResponseInputItem;
  }
  const { chatFileView: _droppedReference, ...sendable } = item;

  return sendable as unknown as OpenAI.Responses.ResponseInputItem;
};

/** The native half of a `view_file` result: one image, or one PDF page. */
export type ChatFileViewPart =
  | OpenAI.Responses.ResponseInputImageContent
  | OpenAI.Responses.ResponseInputFileContent;

/** Native parts rebuilt for this input, by the call id of the result they belong to. */
export type ChatFileViewPartsByCallId = ReadonlyMap<string, ChatFileViewPart>;

export type StoredChatFileViewCall = Readonly<{
  callId: string;
  reference: StoredChatFileViewReference;
}>;

/**
 * Said in place of a part this input does not carry.
 *
 * The stored text part ahead of it already names the file, so this sentence
 * interpolates nothing: a filename is the user's and would be untrusted text
 * sitting flush against an instruction to the model.
 */
const CHAT_FILE_VIEW_UNAVAILABLE_NOTE =
  "The image or page this result showed is not part of this request. "
  + "Call view_file again if you still need to look at it.";

const toOutputTextParts = (
  output: StoredOpenAIReplayFunctionCallOutput["output"],
): ReadonlyArray<OpenAI.Responses.ResponseFunctionCallOutputItem> =>
  typeof output === "string"
    ? [{ type: "input_text", text: output }]
    : output.filter((part) => part.type === "input_text");

/**
 * One `view_file` result as the run that produced it sends it: the text the model
 * reads, and the native part beside it.
 */
export const buildChatFileViewReplayItem = (
  callId: string,
  text: string,
  part: ChatFileViewPart,
  reference: StoredChatFileViewReference,
): StoredOpenAIReplayFunctionCallOutput => ({
  type: "function_call_output",
  call_id: callId,
  output: [{ type: "input_text", text }, part],
  chatFileView: reference,
});

/**
 * The items as a row may hold them.
 *
 * The only transformation is dropping the bytes of a `view_file` result, whose
 * reference stays: see StoredChatFileViewReference for why a stored data URL is
 * the thing this exists to prevent. Applied where the run hands its items over
 * for persistence, so nothing downstream of that has to remember to.
 */
export const toPersistedOpenAIReplayItems = (
  items: ReadonlyArray<StoredOpenAIReplayItem>,
): ReadonlyArray<StoredOpenAIReplayItem> =>
  items.map((item) => (
    item.type === "function_call_output" && item.chatFileView !== undefined
      ? { ...item, output: [...toOutputTextParts(item.output)] }
      : item
  ));

/** Every persisted `view_file` result of a session, oldest first. */
export const listStoredChatFileViewCalls = (
  messages: ReadonlyArray<ServerChatMessage>,
): ReadonlyArray<StoredChatFileViewCall> =>
  messages.flatMap((message) => (
    message.role === "assistant" && message.openaiItems !== undefined
      ? message.openaiItems.flatMap((item): ReadonlyArray<StoredChatFileViewCall> => (
        item.type === "function_call_output" && item.chatFileView !== undefined
          ? [{ callId: item.call_id, reference: item.chatFileView }]
          : []
      ))
      : []
  ));

/**
 * One stored item as this input sends it, with a `view_file` result's bytes put
 * back from `viewParts`.
 *
 * A result whose part is absent keeps its text and says so, rather than being
 * dropped: dropping the output of a call that is still replayed is answered with
 * `400 No tool call found for function call output`, and dropping both would
 * erase a step the model took.
 */
export const toReplayedOpenAIResponseInputItem = (
  item: StoredOpenAIReplayItem,
  viewParts: ChatFileViewPartsByCallId,
): OpenAI.Responses.ResponseInputItem => {
  if (item.type !== "function_call_output" || item.chatFileView === undefined) {
    return toOpenAIResponseInputItem(item);
  }

  const part = viewParts.get(item.call_id);

  return {
    type: "function_call_output",
    call_id: item.call_id,
    output: [
      ...toOutputTextParts(item.output),
      part ?? { type: "input_text", text: CHAT_FILE_VIEW_UNAVAILABLE_NOTE },
    ],
    ...(item.status !== undefined ? { status: item.status } : {}),
  };
};

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
