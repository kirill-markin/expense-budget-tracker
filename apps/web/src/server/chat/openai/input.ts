import type OpenAI from "openai";
import * as XLSX from "xlsx";
import type {
  ChatMessage,
  ContentPart,
  FileContentPart,
  ImageContentPart,
  TextContentPart,
} from "@/server/chat/types";
import { buildSystemInstructions } from "@/server/chat/shared";

type OpenAIInputMessage = OpenAI.Responses.EasyInputMessage;
type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIInputContent = OpenAI.Responses.ResponseInputMessageContentList[number];

class AttachmentSerializationError extends Error {
  public constructor(fileName: string, message: string) {
    super(`Failed to serialize attachment ${fileName}: ${message}`);
    this.name = "AttachmentSerializationError";
  }
}

type AttachmentSummary = Readonly<{
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
}>;

const RAW_TEXT_CSV_MEDIA_TYPES = new Set([
  "text/csv",
  "application/csv",
]);

const RAW_TEXT_CSV_EXTENSIONS = new Set([
  ".csv",
]);

const RAW_TEXT_WORKBOOK_MEDIA_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const RAW_TEXT_WORKBOOK_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
]);

const CHAT_HISTORY_WINDOW = 24;
const MAX_TEXT_HISTORY_LENGTH = 8_000;
const MAX_TOOL_PAYLOAD_LENGTH = 4_000;
const MAX_REASONING_SUMMARY_LENGTH = 2_000;
const MAX_ATTACHMENT_SUMMARY_LENGTH = 600;

const getFileExtension = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
};

const isRawTextCsvAttachment = (part: FileContentPart): boolean =>
  RAW_TEXT_CSV_MEDIA_TYPES.has(part.mediaType) || RAW_TEXT_CSV_EXTENSIONS.has(getFileExtension(part.fileName));

const isRawTextWorkbookAttachment = (part: FileContentPart): boolean =>
  RAW_TEXT_WORKBOOK_MEDIA_TYPES.has(part.mediaType) || RAW_TEXT_WORKBOOK_EXTENSIONS.has(getFileExtension(part.fileName));

const decodeBase64Utf8 = (value: string): string =>
  Buffer.from(value, "base64").toString("utf8");

const trimTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

const buildRawCsvAttachmentText = (part: FileContentPart): string => {
  const rawText = decodeBase64Utf8(part.base64Data);
  return `Attached CSV file: ${part.fileName}\n\`\`\`csv\n${rawText}\n\`\`\``;
};

const buildWorkbookAttachmentText = (part: FileContentPart): string => {
  try {
    const workbook = XLSX.read(Buffer.from(part.base64Data, "base64"), {
      type: "buffer",
    });
    const sheetBlocks = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (sheet === undefined) {
        throw new AttachmentSerializationError(part.fileName, `missing sheet ${sheetName}`);
      }
      const csv = trimTrailingNewline(XLSX.utils.sheet_to_csv(sheet));
      return `Sheet: ${sheetName}\n\`\`\`csv\n${csv}\n\`\`\``;
    });

    return [`Attached workbook: ${part.fileName}`, ...sheetBlocks].join("\n");
  } catch (error) {
    if (error instanceof AttachmentSerializationError) {
      throw error;
    }

    throw new AttachmentSerializationError(
      part.fileName,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const mapUserPart = (
  part: TextContentPart | ImageContentPart | FileContentPart,
): ReadonlyArray<OpenAIInputContent> => {
  switch (part.type) {
    case "text":
      return [{ type: "input_text", text: part.text }];
    case "image":
      return [{
        type: "input_image",
        detail: "auto",
        image_url: `data:${part.mediaType};base64,${part.base64Data}`,
      }];
    case "file":
      if (isRawTextCsvAttachment(part)) {
        return [
          {
            type: "input_text",
            text: buildRawCsvAttachmentText(part),
          },
          {
            type: "input_file",
            filename: part.fileName,
            file_data: `data:${part.mediaType};base64,${part.base64Data}`,
          },
        ];
      }

      if (isRawTextWorkbookAttachment(part)) {
        return [
          {
            type: "input_text",
            text: buildWorkbookAttachmentText(part),
          },
          {
            type: "input_file",
            filename: part.fileName,
            file_data: `data:${part.mediaType};base64,${part.base64Data}`,
          },
        ];
      }

      return [{
        type: "input_file",
        filename: part.fileName,
        file_data: `data:${part.mediaType};base64,${part.base64Data}`,
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

const buildPromptAttachmentSummary = (
  part: FileContentPart | ImageContentPart,
): string => {
  const fileName = part.type === "file" ? part.fileName : "image";
  const summary: AttachmentSummary = {
    fileName,
    mediaType: part.mediaType,
    sizeBytes: Buffer.from(part.base64Data, "base64").byteLength,
  };

  return clipText(JSON.stringify(summary), MAX_ATTACHMENT_SUMMARY_LENGTH);
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

const summarizeMessageContent = (
  parts: ReadonlyArray<ContentPart>,
): string => {
  const chunks: Array<string> = [];

  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(`text: ${clipText(part.text, MAX_TEXT_HISTORY_LENGTH)}`);
      continue;
    }

    if (part.type === "image" || part.type === "file") {
      chunks.push(`attachment: ${buildPromptAttachmentSummary(part)}`);
      continue;
    }

    if (part.type === "tool_call") {
      chunks.push(
        [
          `tool_call: ${part.name}`,
          `status=${part.status}`,
          part.input === null ? null : `input=${clipText(part.input, MAX_TOOL_PAYLOAD_LENGTH)}`,
          part.output === null ? null : `output=${clipText(part.output, MAX_TOOL_PAYLOAD_LENGTH)}`,
        ].filter((value): value is string => value !== null).join(" "),
      );
      continue;
    }

    if (part.type === "reasoning_summary") {
      chunks.push(`reasoning_summary: ${clipText(part.summary, MAX_REASONING_SUMMARY_LENGTH)}`);
    }
  }

  return chunks.join("\n");
};

const formatHistoryMessage = (
  message: ChatMessage,
  index: number,
): string => {
  const header = `${String(index + 1)}. ${message.role.toUpperCase()}`;
  const body = summarizeMessageContent(message.content);
  return `${header}\n${body}`;
};

const normalizeHistoryMessages = (
  localMessages: ReadonlyArray<ChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): ReadonlyArray<ChatMessage> => {
  const lastMessage = localMessages.at(-1);
  if (lastMessage === undefined || lastMessage.role !== "user") {
    return localMessages;
  }

  if (stringifyJson(lastMessage.content) !== stringifyJson(turnInput)) {
    return localMessages;
  }

  return localMessages.slice(0, -1);
};

const buildHistoryTranscript = (
  localMessages: ReadonlyArray<ChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): string | null => {
  const normalizedMessages = normalizeHistoryMessages(localMessages, turnInput);
  if (normalizedMessages.length === 0) {
    return null;
  }

  const historyWindow = normalizedMessages.slice(-CHAT_HISTORY_WINDOW);
  const transcript = historyWindow
    .map(formatHistoryMessage)
    .join("\n\n");

  return [
    "Conversation transcript from the app database.",
    "Treat this as the canonical prior context for the current chat session.",
    "Do not repeat earlier completed work unless new tool results or user input require it.",
    transcript,
  ].join("\n\n");
};

const buildUserTurnMessage = (
  turnInput: ReadonlyArray<ContentPart>,
): OpenAIInputMessage => ({
  role: "user",
  type: "message",
  content: turnInput
    .filter((part): part is TextContentPart | ImageContentPart | FileContentPart =>
      part.type !== "tool_call" && part.type !== "reasoning_summary")
    .flatMap(mapUserPart),
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

export const buildChatCompletionInput = (
  localMessages: ReadonlyArray<ChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  timezone: string,
): ReadonlyArray<OpenAIInputItem> => {
  const input: Array<OpenAIInputItem> = [{
    role: "system",
    type: "message",
    content: buildSystemInstructions(timezone),
  }];

  const historyTranscript = buildHistoryTranscript(localMessages, turnInput);
  if (historyTranscript !== null) {
    input.push({
      role: "developer",
      type: "message",
      content: historyTranscript,
    });
  }

  input.push(buildUserTurnMessage(turnInput));
  return input;
};
