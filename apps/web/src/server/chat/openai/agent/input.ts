import type {
  ChatMessage,
  FileContentPart,
  ImageContentPart,
  TextContentPart,
} from "@/server/chat/types";
import {
  extractText,
  summarizeContent,
} from "@/server/chat/shared";

type UserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string }
  | { type: "input_file"; file: string; filename: string };

type AssistantContentPart = { type: "output_text"; text: string };

export type InputMessage =
  | { role: "user"; content: string | ReadonlyArray<UserContentPart> }
  | { role: "assistant"; content: ReadonlyArray<AssistantContentPart> };

const SPREADSHEET_MEDIA_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
]);

const getLastUserMessage = (
  messages: ReadonlyArray<ChatMessage>,
): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i];
    }
  }
  return null;
};

export const getLatestUserFileAttachments = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (lastUserMessage === null) {
    return [];
  }

  return lastUserMessage.content.filter((part): part is FileContentPart => part.type === "file");
};

const getFileExtension = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
};

const isSpreadsheetAttachment = (part: FileContentPart): boolean =>
  SPREADSHEET_MEDIA_TYPES.has(part.mediaType) || SPREADSHEET_EXTENSIONS.has(getFileExtension(part.fileName));

export const getSpreadsheetAttachmentFileNames = (
  attachments: ReadonlyArray<FileContentPart>,
): ReadonlyArray<string> =>
  attachments.filter(isSpreadsheetAttachment).map((part) => part.fileName);

const mapUserPart = (part: TextContentPart | ImageContentPart | FileContentPart): UserContentPart => {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image":
      return {
        type: "input_image",
        image: `data:${part.mediaType};base64,${part.base64Data}`,
      };
    case "file":
      return {
        type: "input_file",
        file: `data:${part.mediaType};base64,${part.base64Data}`,
        filename: part.fileName,
      };
  }
};

export const buildInput = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<InputMessage> => {
  // Only include actual file data for the latest user message;
  // older attachments are summarized as text since the model already saw them.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: Array<InputMessage> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: [{ type: "output_text", text: extractText(msg.content) }],
      });
      continue;
    }

    const hasAttachments = msg.content.some((part) => part.type !== "text");

    if (!hasAttachments) {
      if (msg.content.length === 1 && msg.content[0].type === "text") {
        result.push({ role: "user", content: msg.content[0].text });
      } else {
        result.push({ role: "user", content: extractText(msg.content) });
      }
      continue;
    }

    if (i === lastUserIdx) {
      result.push({
        role: "user",
        content: msg.content
          .filter((part): part is TextContentPart | ImageContentPart | FileContentPart => part.type !== "tool_call")
          .map(mapUserPart),
      });
    } else {
      result.push({ role: "user", content: summarizeContent(msg.content) });
    }
  }

  return result;
};
