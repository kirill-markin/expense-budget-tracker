import type { AgentInputItem } from "@openai/agents-core";
import * as XLSX from "xlsx";
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

class AttachmentSerializationError extends Error {
  public constructor(fileName: string, message: string) {
    super(`Failed to serialize attachment ${fileName}: ${message}`);
    this.name = "AttachmentSerializationError";
  }
}

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

const CODE_INTERPRETER_MEDIA_TYPES = new Set([
  ...RAW_TEXT_CSV_MEDIA_TYPES,
  "text/tab-separated-values",
  ...RAW_TEXT_WORKBOOK_MEDIA_TYPES,
  "application/pdf",
]);

const CODE_INTERPRETER_EXTENSIONS = new Set([
  ...RAW_TEXT_CSV_EXTENSIONS,
  ".tsv",
  ...RAW_TEXT_WORKBOOK_EXTENSIONS,
  ".pdf",
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
 * Returns only the file attachments from the latest user message. Even when tabular content is
 * also injected into the conversation as raw text, the original files remain available to the
 * model and the code interpreter.
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
 * Returns the distinct file attachments ever seen in local app history. This is used to
 * rehydrate explicit code interpreter containers after reuse or recreation, even though older
 * messages are not replayed to the model as runtime memory.
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

const isRawTextCsvAttachment = (part: FileContentPart): boolean =>
  RAW_TEXT_CSV_MEDIA_TYPES.has(part.mediaType) || RAW_TEXT_CSV_EXTENSIONS.has(getFileExtension(part.fileName));

const isRawTextWorkbookAttachment = (part: FileContentPart): boolean =>
  RAW_TEXT_WORKBOOK_MEDIA_TYPES.has(part.mediaType) || RAW_TEXT_WORKBOOK_EXTENSIONS.has(getFileExtension(part.fileName));

const isCodeInterpreterAttachment = (part: FileContentPart): boolean =>
  CODE_INTERPRETER_MEDIA_TYPES.has(part.mediaType) || CODE_INTERPRETER_EXTENSIONS.has(getFileExtension(part.fileName));

export const getCodeInterpreterAttachmentFileNames = (
  attachments: ReadonlyArray<FileContentPart>,
): ReadonlyArray<string> =>
  attachments.filter(isCodeInterpreterAttachment).map((part) => part.fileName);

const decodeBase64Utf8 = (value: string): string =>
  Buffer.from(value, "base64").toString("utf8");

const buildRawCsvAttachmentText = (part: FileContentPart): string => {
  const rawText = decodeBase64Utf8(part.base64Data);
  return `Attached CSV file: ${part.fileName}\n\`\`\`csv\n${rawText}\n\`\`\``;
};

const trimTrailingNewline = (value: string): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

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

const mapUserPart = (part: TextContentPart | ImageContentPart | FileContentPart): ReadonlyArray<UserContentPart> => {
  switch (part.type) {
    case "text":
      return [{ type: "input_text", text: part.text }];
    case "image":
      return [{
        type: "input_image",
        image: `data:${part.mediaType};base64,${part.base64Data}`,
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
            file: `data:${part.mediaType};base64,${part.base64Data}`,
            filename: part.fileName,
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
            file: `data:${part.mediaType};base64,${part.base64Data}`,
            filename: part.fileName,
          },
        ];
      }
      return [{
        type: "input_file",
        file: `data:${part.mediaType};base64,${part.base64Data}`,
        filename: part.fileName,
      }];
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
    .filter((part): part is TextContentPart | ImageContentPart | FileContentPart =>
      part.type !== "tool_call" && part.type !== "reasoning_summary")
    .flatMap(mapUserPart),
}];
