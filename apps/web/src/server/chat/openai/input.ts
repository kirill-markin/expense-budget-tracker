import type OpenAI from "openai";
import type {
  ChatMessage,
  ContentPart,
  FileContentPart,
  ImageContentPart,
  TextContentPart,
} from "@/server/chat/types";
import {
  buildDocxPromptText,
  buildTextFilePromptText,
  buildWorkbookPromptText,
  isDocxAttachment,
  isTextFileAttachment,
  isWorkbookAttachment,
} from "@/lib/chatAttachments";
import { buildSystemInstructions } from "@/server/chat/shared";

type OpenAIInputItem = OpenAI.Responses.ResponseInputItem;
type OpenAIInputContent = OpenAI.Responses.ResponseInputMessageContentList[number];
type OpenAIAssistantOutputContent = OpenAI.Responses.ResponseOutputMessage["content"][number];

type AttachmentSummary = Readonly<{
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
}>;

const MAX_TEXT_HISTORY_LENGTH = 8_000;
const MAX_TOOL_PAYLOAD_LENGTH = 4_000;
const MAX_REASONING_SUMMARY_LENGTH = 2_000;

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

const mapAssistantHistoryPart = async (
  part: ContentPart,
): Promise<ReadonlyArray<OpenAIAssistantOutputContent>> => {
  if (part.type === "text") {
    return [{
      type: "output_text",
      text: part.text,
      annotations: [],
    }];
  }

  if (part.type === "tool_call") {
    return [{
      type: "output_text",
      text: buildToolCallHistoryText(part),
      annotations: [],
    }];
  }

  if (part.type === "reasoning_summary") {
    return [{
      type: "output_text",
      text: buildReasoningHistoryText(part),
      annotations: [],
    }];
  }

  throw new Error(`Assistant history contains unsupported content part: ${part.type}`);
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

const buildInputMessage = async (
  role: ChatMessage["role"],
  content: ReadonlyArray<ContentPart>,
  messageIndex: number,
): Promise<OpenAIInputItem> => {
  if (role === "assistant") {
    return {
      id: `assistant-history-${String(messageIndex)}`,
      role,
      status: "completed",
      type: "message",
      content: (await Promise.all(content.map(mapAssistantHistoryPart))).flat(),
    };
  }

  return {
    role,
    type: "message",
    content: (await Promise.all(content.map(mapMessagePart))).flat(),
  };
};

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
  localMessages: ReadonlyArray<ChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
  timezone: string,
): Promise<ReadonlyArray<OpenAIInputItem>> => {
  /**
   * Rebuild the full app-owned session history instead of relying on
   * provider-managed conversation state. This keeps previously attached files
   * available on later turns, with the same attachment policy as the current
   * user turn.
   */
  const input: Array<OpenAIInputItem> = [{
    role: "system",
    type: "message",
    content: buildSystemInstructions(timezone),
  }];

  const normalizedHistory = normalizeHistoryMessages(localMessages, turnInput);
  for (const [messageIndex, message] of normalizedHistory.entries()) {
    if (message.content.length === 0) {
      continue;
    }
    input.push(await buildInputMessage(message.role, message.content, messageIndex));
  }

  input.push(await buildInputMessage("user", turnInput, normalizedHistory.length));
  return input;
};
