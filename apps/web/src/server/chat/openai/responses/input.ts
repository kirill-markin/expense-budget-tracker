import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";
import {
  isInlineFileContentPart,
  isInlineImageContentPart,
  type ContentPart,
  type FileContentPart,
  type ImageContentPart,
  type InlineFileContentPart,
  type InlineImageContentPart,
  type PdfContentPart,
  type UnconvertedContentPart,
} from "@/server/chat/types";
import { getPdfDerivedImageByteLength } from "@/lib/chatPdf";
import { CHAT_SENT_INPUT_BUDGET_TOKENS } from "@/lib/chatModels";
import { planChatHistoryReplay } from "@/server/chat/openai/responses/history";
import {
  normalizeStoredOpenAIReplayItems,
  replayItemsFromCompaction,
  toReplayedOpenAIResponseInputItem,
  type ChatFileViewPartsByCallId,
  type ServerChatMessage,
} from "@/server/chat/openai/responses/replayItems";
import type {
  ChatImageSendState,
  ChatTurnFileContext,
} from "@/server/chatFiles/sessionContext";
import {
  CHAT_ATTACHMENT_MAXIMUM_BYTES,
  ChatAttachmentTooLargeError,
  HeicFileAttachmentError,
  ImageMimeSignatureMismatchError,
  InvalidPdfAttachmentError,
  InvalidBase64ImageDataError,
  LegacyPdfFileAttachmentError,
  UnsupportedImageMediaTypeError,
  validateChatAttachments,
} from "@/server/chat/attachments/validation";
import { buildChatFilePromptText } from "@/server/chat/openai/responses/chatFilePrompt";
import { buildSystemInstructions, formatDatetime } from "@/server/chat/shared";
import { log } from "@/server/logger";
import { quoteUntrustedSandboxValue } from "../../../../../../sandbox/src/contract";

type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIInputContent = OpenAI.Responses.ResponseInputMessageContentList[number];

export type ChatCompletionInput = Readonly<{
  items: ReadonlyArray<OpenAIInputItem>;
  /**
   * Stored messages whose content this input sent, counted back from the
   * assistant message this turn is about to persist. That message lands right
   * after `localMessages`, so `localMessages.length - startIndex` is exact on
   * the production path, where the current user turn is already stored among
   * them. Called with the turn input absent from `localMessages` it over-counts
   * by one, which sizes the attributed range one message wider than the call
   * sent - the safe direction, since it spreads a measurement over more history
   * rather than less. It is what later turns need to attribute this call's
   * measured usage to the messages it sent.
   */
  replayedMessages: number;
}>;

type AttachmentSummary = Readonly<{
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
  pageCount?: number;
  extractedTextCharacters?: number;
}>;

const MAX_TEXT_HISTORY_LENGTH = 8_000;
const MAX_TOOL_PAYLOAD_LENGTH = 4_000;
const MAX_REASONING_SUMMARY_LENGTH = 2_000;

const isChatAttachmentValidationError = (error: unknown): error is Error =>
  error instanceof ChatAttachmentTooLargeError
  || error instanceof HeicFileAttachmentError
  || error instanceof ImageMimeSignatureMismatchError
  || error instanceof InvalidPdfAttachmentError
  || error instanceof InvalidBase64ImageDataError
  || error instanceof LegacyPdfFileAttachmentError
  || error instanceof UnsupportedImageMediaTypeError;

export class UnsupportedStoredChatAttachmentError extends Error {
  public readonly fileName: string | null;
  public readonly mediaType: string;

  public constructor(
    messageIndex: number,
    partIndex: number,
    part: FileContentPart | ImageContentPart | PdfContentPart,
    cause: Error,
  ) {
    const fileName = part.type === "image"
      ? null
      : (part.type === "pdf" ? part.fileName : part.path);
    const fileNameContext = fileName === null
      ? ""
      : `, filename ${JSON.stringify(fileName)}`;
    super(
      `Stored user message ${String(messageIndex)} content part ${String(partIndex)} `
      + `(media type ${JSON.stringify(part.mediaType)}${fileNameContext}) cannot be replayed `
      + "because the attachment is unsupported.",
      { cause },
    );
    this.name = "UnsupportedStoredChatAttachmentError";
    this.fileName = fileName;
    this.mediaType = part.mediaType;
  }
}

export const buildPdfPagePromptText = (
  part: PdfContentPart,
  pageNumber: number,
  pageText: string,
): string => [
  `Attached PDF: ${part.fileName}, page ${String(pageNumber)} of ${String(part.pages.length)}.`,
  "The extracted text below and the following image are two representations of the same PDF page.",
  "Use the extracted text for exact values and the image for layout. Do not treat them as duplicate transactions.",
  "Extracted text:",
  pageText.length === 0
    ? "[No embedded text was extracted from this page.]"
    : pageText,
].join("\n");

const mapPdfAttachmentPart = (
  part: PdfContentPart,
): ReadonlyArray<OpenAIInputContent> =>
  part.pages.flatMap((page): ReadonlyArray<OpenAIInputContent> => [
    {
      type: "input_text",
      text: buildPdfPagePromptText(part, page.pageNumber, page.text),
    },
    {
      type: "input_image",
      detail: "high",
      image_url: `data:image/jpeg;base64,${page.jpegBase64Data}`,
    },
  ]);

/**
 * Said in place of an image past CHAT_RESIDENT_IMAGES_PER_TURN, whose stored
 * object is still there to be read. It names the path because that is what
 * `view_file` takes, and the manifest names the same path for as long as the
 * file exists.
 */
const buildCappedImagePromptText = (
  part: ImageContentPart,
): string =>
  `Attached image ${quoteUntrustedSandboxValue(part.path)}, ${String(part.sizeBytes)} bytes. `
  + "This message does not carry its pixels; call view_file with that path to look at it.";

/**
 * Said in place of an image this turn could not read the bytes of, which gets no
 * `view_file` instruction: that tool reads the very same object, so the call
 * could only fail - and an expired object is the state every image of an old
 * enough session is in, on every turn.
 */
const buildUnavailableImagePromptText = (
  part: ImageContentPart,
): string =>
  `Attached image ${quoteUntrustedSandboxValue(part.path)}, ${String(part.sizeBytes)} bytes, `
  + "is no longer available in this chat and cannot be shown. Tell the user it has to be "
  + "attached again if they need it looked at.";

/**
 * Said in place of an image whose stored row is past the bytes one image may be
 * shown as. It carries neither instruction the other two do: `view_file` refuses
 * the same row under the same ceiling, and the wire refuses an attachment of
 * that size on arrival, so the only thing that can answer is a smaller copy.
 */
const buildOversizedImagePromptText = (
  part: ImageContentPart,
): string =>
  `Attached image ${quoteUntrustedSandboxValue(part.path)}, ${String(part.sizeBytes)} bytes, `
  + `is past the ${String(CHAT_ATTACHMENT_MAXIMUM_BYTES)} bytes one image may be shown as, so `
  + "this chat cannot show it at all. Tell the user it is too large to look at, and that only a "
  + "smaller copy of it could be attached.";

/**
 * The image's own bytes, rendered the one way that keeps the prompt cache: a
 * data URL over the stored object, byte for byte the same on every turn.
 *
 * Never a pre-signed URL, which would be the cheaper send: the cache matches on
 * a byte-identical rendered prefix and a SigV4 signature changes every turn, so
 * that URL would cost the whole prompt behind this message. `detail` is constant
 * for the same reason.
 */
const mapResidentImagePart = (
  part: ImageContentPart,
  base64Data: string,
): OpenAIInputContent => ({
  type: "input_image",
  detail: "auto",
  image_url: `data:${part.mediaType};base64,${base64Data}`,
});

/**
 * One stored image as this turn sends it: its own bytes where the turn read
 * them, and otherwise the line that says what the model may still do about it.
 *
 * An image with no state of its own is sent as a capped one, which is the turn
 * the user abandoned: it read no object, so nothing is known against the file,
 * and the instruction that can still answer is the one that says it is there.
 */
const mapImagePart = (
  part: ImageContentPart,
  state: ChatImageSendState | undefined,
): OpenAIInputContent => {
  if (state === undefined || state.kind === "capped") {
    return { type: "input_text", text: buildCappedImagePromptText(part) };
  }
  if (state.kind === "unavailable") {
    return { type: "input_text", text: buildUnavailableImagePromptText(part) };
  }
  if (state.kind === "oversized") {
    return { type: "input_text", text: buildOversizedImagePromptText(part) };
  }

  return mapResidentImagePart(part, state.base64Data);
};

/**
 * One stored attachment as this turn resends it.
 *
 * - images -> native `input_image` read back from storage, or the line that says
 *   whether the file is still there to be looked at
 * - logical PDFs -> ordered extracted-text + JPEG page pairs
 * - documents -> the one line that names the file the sandbox mounts
 */
const mapAttachmentPart = (
  part: ImageContentPart | FileContentPart | PdfContentPart,
  imageStateByFileId: ReadonlyMap<string, ChatImageSendState>,
): ReadonlyArray<OpenAIInputContent> => {
  switch (part.type) {
    case "image":
      return [mapImagePart(part, imageStateByFileId.get(part.fileId))];
    case "pdf":
      return mapPdfAttachmentPart(part);
    case "file":
      return [{ type: "input_text", text: buildChatFilePromptText(part) }];
  }
};

const clipText = (
  value: string,
  maxLength: number,
): string =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...`;

const buildToolCallHistoryText = (
  part: Extract<ContentPart, { type: "tool_call" }>,
): string =>
  [
    `Tool call: ${part.name}`,
    `Status: ${part.status}`,
    part.providerStatus === undefined || part.providerStatus === null
      ? null
      : `Provider status: ${part.providerStatus}`,
    part.input === null ? null : `Input:\n${part.input}`,
    part.output === null ? null : `Output:\n${part.output}`,
  ].filter((value): value is string => value !== null).join("\n");

const buildReasoningHistoryText = (
  part: Extract<ContentPart, { type: "reasoning_summary" }>,
): string =>
  `Reasoning summary:\n${part.summary}`;

const mapMessagePart = (
  part: ContentPart,
  imageStateByFileId: ReadonlyMap<string, ChatImageSendState>,
): ReadonlyArray<OpenAIInputContent> => {
  if (part.type === "text") {
    return [{ type: "input_text", text: part.text }];
  }

  if (part.type === "image" || part.type === "file" || part.type === "pdf") {
    return mapAttachmentPart(part, imageStateByFileId);
  }

  if (part.type === "tool_call") {
    return [{ type: "input_text", text: buildToolCallHistoryText(part) }];
  }

  return [{ type: "input_text", text: buildReasoningHistoryText(part) }];
};

const bytesToHex = (
  bytes: Uint8Array,
): string =>
  [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const buildTelemetryAttachmentSummary = async (
  part:
    | FileContentPart
    | InlineFileContentPart
    | ImageContentPart
    | InlineImageContentPart
    | PdfContentPart,
): Promise<AttachmentSummary> => {
  if (part.type === "pdf") {
    return {
      fileName: part.fileName,
      mediaType: part.mediaType,
      sizeBytes: getPdfDerivedImageByteLength(part),
      sha256: part.sourceSha256,
      pageCount: part.pages.length,
      extractedTextCharacters: part.pages.reduce(
        (total, page) => total + page.text.length,
        0,
      ),
    };
  }

  if (isInlineImageContentPart(part) || isInlineFileContentPart(part)) {
    const contentBytes = Buffer.from(part.base64Data, "base64");
    const digest = await crypto.subtle.digest("SHA-256", contentBytes);

    return {
      fileName: part.type === "image" ? "image" : part.fileName,
      mediaType: part.mediaType,
      sizeBytes: contentBytes.byteLength,
      sha256: bytesToHex(new Uint8Array(digest)),
    };
  }

  // A referenced attachment carries the stored row's own measurements, so there
  // are no bytes here to hash and none to read. An image part carries no digest
  // of them either: it is resolved and read by file id, so nothing needs one.
  if (part.type === "image") {
    return {
      fileName: part.path,
      mediaType: part.mediaType,
      sizeBytes: part.sizeBytes,
    };
  }

  return {
    fileName: part.path,
    mediaType: part.mediaType,
    sizeBytes: part.sizeBytes,
    sha256: part.sha256,
  };
};

const normalizeHistoryMessages = (
  localMessages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): ReadonlyArray<ServerChatMessage> => {
  const lastMessage = localMessages.at(-1);
  if (lastMessage === undefined || lastMessage.role !== "user") {
    return localMessages;
  }

  if (!isDeepStrictEqual(lastMessage.content, turnInput)) {
    return localMessages;
  }

  return localMessages.slice(0, -1);
};

const validateStoredUserMessageAttachments = (
  content: ReadonlyArray<ContentPart>,
  messageIndex: number,
): void => {
  content.forEach((part, partIndex): void => {
    if (part.type !== "image" && part.type !== "file" && part.type !== "pdf") {
      return;
    }

    try {
      validateChatAttachments([part]);
    } catch (error) {
      if (!isChatAttachmentValidationError(error)) {
        throw error;
      }
      throw new UnsupportedStoredChatAttachmentError(
        messageIndex,
        partIndex,
        part,
        error,
      );
    }
  });
};

const validateReplayAttachments = (
  replayedMessages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  messageIndexOffset: number,
): void => {
  replayedMessages.forEach((message, messageIndex): void => {
    if (message.role === "user") {
      validateStoredUserMessageAttachments(
        message.content,
        messageIndexOffset + messageIndex,
      );
    }
  });
  validateChatAttachments(turnInput);
};

/**
 * A compaction item is replayable only as the first item of the replay: it
 * stands for everything sent ahead of it. One left anywhere else - a window
 * start that reaches back past a compaction item the budget no longer accepts -
 * would restate context this input is sending in full, so it is dropped.
 *
 * Those items are dropped after normalization rather than before it, so an
 * unreplayable one is still counted and reported: filtering them out first made
 * `droppedCompactionItems` zero by construction on every windowed replay and
 * silenced the `missing_replay_fields` signal for the items that really are
 * broken.
 */
const buildAssistantHistoryItems = (
  message: ServerChatMessage,
  compactionItemIndex: number | null,
  viewParts: ChatFileViewPartsByCallId,
): ReadonlyArray<OpenAIInputItem> => {
  if (message.openaiItems !== undefined) {
    const replayedItems = compactionItemIndex === null
      ? message.openaiItems
      : replayItemsFromCompaction(message.openaiItems, compactionItemIndex);
    const {
      items,
      droppedReasoningItems,
      droppedCompactionItems,
    } = normalizeStoredOpenAIReplayItems(replayedItems);
    if (droppedReasoningItems > 0) {
      log({
        domain: "chat",
        action: "replay_item_dropped",
        vendor: "openai",
        itemType: "reasoning",
        reason: "missing_encrypted_content",
        count: droppedReasoningItems,
      });
    }
    if (droppedCompactionItems > 0) {
      log({
        domain: "chat",
        action: "replay_item_dropped",
        vendor: "openai",
        itemType: "compaction",
        reason: "missing_replay_fields",
        count: droppedCompactionItems,
      });
    }

    const replayableItems = compactionItemIndex === null
      ? items.filter((item) => item.type !== "compaction")
      : items;

    return replayableItems.map(
      (item) => toReplayedOpenAIResponseInputItem(item, viewParts),
    );
  }

  return [];
};

const buildUserInputMessage = (
  content: ReadonlyArray<ContentPart>,
  imageStateByFileId: ReadonlyMap<string, ChatImageSendState>,
): OpenAIInputItem => ({
  role: "user",
  type: "message",
  content: content.flatMap((part) => mapMessagePart(part, imageStateByFileId)),
});

export const sanitizeContentPartsForTelemetry = async (
  content: ReadonlyArray<UnconvertedContentPart>,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> =>
  await Promise.all(content.map(async (part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: clipText(part.text, MAX_TEXT_HISTORY_LENGTH),
      };
    }

    if (part.type === "image" || part.type === "file" || part.type === "pdf") {
      return {
        type: part.type,
        summary: await buildTelemetryAttachmentSummary(part),
      };
    }

    if (part.type === "tool_call") {
      return {
        type: "tool_call",
        name: part.name,
        status: part.status,
        providerStatus: part.providerStatus ?? null,
        input: part.input === null ? null : clipText(part.input, MAX_TOOL_PAYLOAD_LENGTH),
        output: part.output === null ? null : clipText(part.output, MAX_TOOL_PAYLOAD_LENGTH),
      };
    }

    return {
      type: "reasoning_summary",
      summary: clipText(part.summary, MAX_REASONING_SUMMARY_LENGTH),
    };
  }));

export const buildChatCompletionInput = async (
  localMessages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  timezone: string,
  sessionId: string,
  requestId: string,
  fileContext: ChatTurnFileContext,
): Promise<ChatCompletionInput> => {
  /**
   * Rebuild the app-owned session history for manual Responses API context
   * management.
   *
   * User turns replay from app transcript content so attachments can be
   * rehydrated with the same policy as the current turn. Assistant turns replay
   * only from persisted native OpenAI items stored in `openaiItems`.
   *
   * The replay starts at the newest persisted compaction item, whose encrypted
   * summary already carries every turn ahead of it, and otherwise as early as
   * the token budget for this whole input allows.
   */
  const normalizedHistory = normalizeHistoryMessages(localMessages, turnInput);
  const plan = planChatHistoryReplay(
    normalizedHistory,
    turnInput,
    fileContext.manifest ?? undefined,
  );
  const replayedHistory = normalizedHistory.slice(plan.startIndex);
  validateReplayAttachments(replayedHistory, turnInput, plan.startIndex);

  const input: Array<OpenAIInputItem> = [{
    role: "system",
    type: "message",
    content: buildSystemInstructions(),
  }];

  for (const [offset, message] of replayedHistory.entries()) {
    if (message.role === "assistant") {
      input.push(...buildAssistantHistoryItems(
        message,
        offset === 0 ? plan.compactionItemIndex : null,
        fileContext.viewParts,
      ));
      continue;
    }

    if (message.content.length === 0) {
      continue;
    }
    input.push(buildUserInputMessage(message.content, fileContext.imageStateByFileId));
  }

  input.push(buildUserInputMessage(turnInput, fileContext.imageStateByFileId));

  // What the session's files are now, which the instructions cannot carry: they
  // are the cached prefix and this changes as the user uploads and the model
  // writes. Behind the user's message, so the model reads the request first, and
  // ahead of the clock, which stays the last item. An in-run compaction cut
  // drops it along with the rest, and that is correct: the compaction item it
  // produced already stands for this listing.
  if (fileContext.manifest !== null) {
    input.push({
      role: "system",
      type: "message",
      content: fileContext.manifest,
    });
  }

  // The clock is the only part of the prompt that moves between turns, so it is
  // the last input item. OpenAI matches the cache on the longest byte-identical
  // prefix, so everything ahead of it - instructions, replayed history and the
  // current user message - stays inside the prefix the next turn can reuse.
  input.push({
    role: "system",
    type: "message",
    content: formatDatetime(timezone),
  });

  const { boundary } = plan;
  if (boundary !== "none") {
    log({
      domain: "chat",
      action: "history_bounded",
      vendor: "openai",
      requestId,
      sessionId,
      boundary,
      droppedMessages: plan.droppedMessages,
      unboundedSentInputTokens: plan.unboundedSentInputTokens,
      sentInputTokens: plan.sentInputTokens,
      budgetTokens: CHAT_SENT_INPUT_BUDGET_TOKENS,
    });
  }

  return {
    items: input,
    replayedMessages: localMessages.length - plan.startIndex,
  };
};
