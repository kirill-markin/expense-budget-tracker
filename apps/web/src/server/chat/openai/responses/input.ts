import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";
import {
  isInlineFileContentPart,
  type ContentPart,
  type FileContentPart,
  type ImageContentPart,
  type InlineFileContentPart,
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
import type { ChatTurnFileContext } from "@/server/chatFiles/sessionContext";
import {
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
 * One stored attachment as this turn resends it.
 *
 * - images -> native `input_image`
 * - logical PDFs -> ordered extracted-text + JPEG page pairs
 * - documents -> the one line that names the file the sandbox mounts
 */
const mapAttachmentPart = (
  part: ImageContentPart | FileContentPart | PdfContentPart,
): ReadonlyArray<OpenAIInputContent> => {
  switch (part.type) {
    case "image":
      return [{
        type: "input_image",
        detail: "auto",
        image_url: `data:${part.mediaType};base64,${part.base64Data}`,
      }];
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
): ReadonlyArray<OpenAIInputContent> => {
  if (part.type === "text") {
    return [{ type: "input_text", text: part.text }];
  }

  if (part.type === "image" || part.type === "file" || part.type === "pdf") {
    return mapAttachmentPart(part);
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
  part: FileContentPart | InlineFileContentPart | ImageContentPart | PdfContentPart,
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

  if (part.type === "image" || isInlineFileContentPart(part)) {
    const contentBytes = Buffer.from(part.base64Data, "base64");
    const digest = await crypto.subtle.digest("SHA-256", contentBytes);

    return {
      fileName: part.type === "image" ? "image" : part.fileName,
      mediaType: part.mediaType,
      sizeBytes: contentBytes.byteLength,
      sha256: bytesToHex(new Uint8Array(digest)),
    };
  }

  // A referenced document carries the stored row's own measurements, so there
  // are no bytes here to hash and none to read.
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
): OpenAIInputItem => ({
  role: "user",
  type: "message",
  content: content.flatMap((part) => mapMessagePart(part)),
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
    input.push(buildUserInputMessage(message.content));
  }

  input.push(buildUserInputMessage(turnInput));

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
