import type OpenAI from "openai";
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
} from "@/server/chat/types";
import {
  buildDocxPromptText,
  buildTextFilePromptText,
  buildWorkbookPromptText,
  isDocxAttachment,
  isTextFileAttachment,
  isWorkbookAttachment,
} from "@/lib/chatAttachments";
import {
  normalizeStoredOpenAIReplayItems,
  toOpenAIResponseInputItem,
  type ServerChatMessage,
} from "@/server/chat/openai/responses/replayItems";
import {
  HeicFileAttachmentError,
  ImageMimeSignatureMismatchError,
  InvalidBase64ImageDataError,
  UnsupportedImageMediaTypeError,
  validateChatAttachments,
} from "@/server/chat/attachments/validation";
import { buildSystemInstructions } from "@/server/chat/shared";
import { log } from "@/server/logger";

type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIInputContent = OpenAI.Responses.ResponseInputMessageContentList[number];

type AttachmentSummary = Readonly<{
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
}>;

const MAX_TEXT_HISTORY_LENGTH = 8_000;
const MAX_TOOL_PAYLOAD_LENGTH = 4_000;
const MAX_REASONING_SUMMARY_LENGTH = 2_000;

const isChatAttachmentValidationError = (error: unknown): error is Error =>
  error instanceof HeicFileAttachmentError
  || error instanceof ImageMimeSignatureMismatchError
  || error instanceof InvalidBase64ImageDataError
  || error instanceof UnsupportedImageMediaTypeError;

export class UnsupportedStoredChatAttachmentError extends Error {
  public readonly fileName: string | null;
  public readonly mediaType: string;

  public constructor(
    messageIndex: number,
    partIndex: number,
    part: FileContentPart | ImageContentPart,
    cause: Error,
  ) {
    const fileName = part.type === "file" ? part.fileName : null;
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

const buildFileDataUrl = (
  part: FileContentPart,
): string =>
  `data:${part.mediaType};base64,${part.base64Data}`;

/**
 * Maps a persisted attachment back into the exact content shape we want to
 * resend to the model on later turns.
 *
 * The policy is intentionally format-aware:
 * - text-like files -> `input_text` + original `input_file`
 * - workbooks -> extracted CSV text + original `input_file`
 * - DOCX -> extracted raw text + original `input_file`
 * - images -> native `input_image`
 * - PDFs and other binaries -> native `input_file` only
 */
const mapAttachmentPart = async (
  part: ImageContentPart | FileContentPart,
): Promise<ReadonlyArray<OpenAIInputContent>> => {
  switch (part.type) {
    case "image":
      return [{
        type: "input_image",
        detail: "auto",
        image_url: `data:${part.mediaType};base64,${part.base64Data}`,
      }];
    case "file":
      if (isTextFileAttachment(part)) {
        return [
          {
            type: "input_text",
            text: buildTextFilePromptText(part),
          },
          {
            type: "input_file",
            filename: part.fileName,
            file_data: buildFileDataUrl(part),
          },
        ];
      }

      if (isWorkbookAttachment(part)) {
        return [
          {
            type: "input_text",
            text: buildWorkbookPromptText(part),
          },
          {
            type: "input_file",
            filename: part.fileName,
            file_data: buildFileDataUrl(part),
          },
        ];
      }

      if (isDocxAttachment(part)) {
        return [
          {
            type: "input_text",
            text: await buildDocxPromptText(part),
          },
          {
            type: "input_file",
            filename: part.fileName,
            file_data: buildFileDataUrl(part),
          },
        ];
      }

      return [{
        type: "input_file",
        filename: part.fileName,
        file_data: buildFileDataUrl(part),
      }];
  }
};

const clipText = (
  value: string,
  maxLength: number,
): string =>
  value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...`;

const stringifyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

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

const mapMessagePart = async (
  part: ContentPart,
): Promise<ReadonlyArray<OpenAIInputContent>> => {
  if (part.type === "text") {
    return [{ type: "input_text", text: part.text }];
  }

  if (part.type === "image" || part.type === "file") {
    return await mapAttachmentPart(part);
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
  part: FileContentPart | ImageContentPart,
): Promise<AttachmentSummary> => {
  const fileName = part.type === "file" ? part.fileName : "image";
  const contentBytes = Buffer.from(part.base64Data, "base64");
  const digest = await crypto.subtle.digest("SHA-256", contentBytes);

  return {
    fileName,
    mediaType: part.mediaType,
    sizeBytes: contentBytes.byteLength,
    sha256: bytesToHex(new Uint8Array(digest)),
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

  if (stringifyJson(lastMessage.content) !== stringifyJson(turnInput)) {
    return localMessages;
  }

  return localMessages.slice(0, -1);
};

const validateStoredUserMessageAttachments = (
  content: ReadonlyArray<ContentPart>,
  messageIndex: number,
): void => {
  content.forEach((part, partIndex): void => {
    if (part.type !== "image" && part.type !== "file") {
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
  localMessages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): void => {
  localMessages.forEach((message, messageIndex): void => {
    if (message.role === "user") {
      validateStoredUserMessageAttachments(message.content, messageIndex);
    }
  });
  validateChatAttachments(turnInput);
};

const buildAssistantHistoryItems = (
  message: ServerChatMessage,
): ReadonlyArray<OpenAIInputItem> => {
  if (message.openaiItems !== undefined) {
    const { items, droppedReasoningItems } = normalizeStoredOpenAIReplayItems(message.openaiItems);
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

    return items.map(toOpenAIResponseInputItem);
  }

  return [];
};

const buildUserInputMessage = async (
  content: ReadonlyArray<ContentPart>,
): Promise<OpenAIInputItem> => ({
  role: "user",
  type: "message",
  content: (await Promise.all(content.map(mapMessagePart))).flat(),
});

export const sanitizeContentPartsForTelemetry = async (
  content: ReadonlyArray<ContentPart>,
): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>> =>
  await Promise.all(content.map(async (part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: clipText(part.text, MAX_TEXT_HISTORY_LENGTH),
      };
    }

    if (part.type === "image" || part.type === "file") {
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
): Promise<ReadonlyArray<OpenAIInputItem>> => {
  /**
   * Rebuild the full app-owned session history for manual Responses API
   * context management.
   *
   * User turns replay from app transcript content so attachments can be
   * rehydrated with the same policy as the current turn. Assistant turns replay
   * only from persisted native OpenAI items stored in `openaiItems`.
   */
  const normalizedHistory = normalizeHistoryMessages(localMessages, turnInput);
  validateReplayAttachments(normalizedHistory, turnInput);

  const input: Array<OpenAIInputItem> = [{
    role: "system",
    type: "message",
    content: buildSystemInstructions(timezone),
  }];

  for (const message of normalizedHistory) {
    if (message.role === "assistant") {
      input.push(...buildAssistantHistoryItems(message));
      continue;
    }

    if (message.content.length === 0) {
      continue;
    }
    input.push(await buildUserInputMessage(message.content));
  }

  input.push(await buildUserInputMessage(turnInput));
  return input;
};
