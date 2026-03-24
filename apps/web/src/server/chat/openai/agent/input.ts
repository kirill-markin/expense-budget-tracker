import type { AgentInputItem } from "@openai/agents-core";
import type {
  ChatMessage,
  ContentPart,
  FileContentPart,
  ImageContentPart,
  TextContentPart,
} from "@/server/chat/types";

type UserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string }
  | { type: "input_file"; file: string; filename: string };

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

/**
 * Returns only the file attachments from the latest user message in local app history.
 * These files determine what needs to be attached directly to the current OpenAI turn.
 */
export const getLatestUserFileAttachments = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (lastUserMessage === null) {
    return [];
  }

  return lastUserMessage.content.filter((part): part is FileContentPart => part.type === "file");
};

/**
 * Returns the distinct file attachments ever seen in local app history for the session.
 * This is used to rehydrate explicit code interpreter containers after reuse or recreation,
 * even though older messages are not replayed to the model as runtime memory.
 */
export const getAllUserFileAttachments = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const seen = new Set<string>();
  const attachments: Array<FileContentPart> = [];

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "file") {
        continue;
      }

      const signature = `${part.fileName}\u0000${part.mediaType}\u0000${part.base64Data}`;
      if (seen.has(signature)) {
        continue;
      }

      seen.add(signature);
      attachments.push(part);
    }
  }

  return attachments;
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

/**
 * Builds the OpenAI input for exactly one new user turn.
 * Prior turns are intentionally omitted here because runtime conversation memory is continued
 * via the stored OpenAI `conversationId`, while local history stays in Postgres for UI, audit,
 * and attachment/container rehydration.
 */
export const buildInput = (
  content: ReadonlyArray<ContentPart>,
): ReadonlyArray<AgentInputItem> => [{
  role: "user",
  type: "message",
  content: content
    .filter((part): part is TextContentPart | ImageContentPart | FileContentPart => part.type !== "tool_call")
    .map(mapUserPart),
}];
