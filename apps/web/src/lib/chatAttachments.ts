import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { FileContentPart, ImageContentPart } from "@/server/chat/types";

/**
 * Canonical attachment policy shared by runtime chat input reconstruction and
 * markdown export generation.
 *
 * Runtime / model-input behavior:
 * - Plain text-like files are decoded as UTF-8 and sent both as `input_text`
 *   and as the original `input_file`.
 * - XLS/XLSX workbooks are converted to per-sheet CSV text and sent both as
 *   `input_text` and as the original `input_file`.
 * - DOCX files are deterministically converted to raw text and sent both as
 *   `input_text` and as the original `input_file`.
 * - Images remain native `input_image` items backed by base64 data URLs.
 * - PDFs stay native OpenAI `input_file` attachments because we do not claim to
 *   locally reproduce the same PDF understanding as the model.
 * - Other binary formats stay as native `input_file` attachments only.
 *
 * Markdown export behavior:
 * - Text-like files render as fenced code/text blocks.
 * - XLS/XLSX render as per-sheet CSV blocks.
 * - DOCX renders as extracted raw text when extraction succeeds.
 * - Images render as `[binary-data]`.
 * - PDFs render as `[pdf-openai-native-attached]`.
 * - Other opaque binaries render as `[binary-data]`.
 */
export type AttachmentContentPart = FileContentPart | ImageContentPart;

export type MarkdownAttachment = Readonly<{
  label: string;
  mediaType: string;
  lines: ReadonlyArray<string>;
}>;

export const BINARY_DATA_PLACEHOLDER = "[binary-data]";
export const PDF_OPENAI_NATIVE_PLACEHOLDER = "[pdf-openai-native-attached]";
export const DOCX_OPENAI_NATIVE_PLACEHOLDER = "[docx-openai-native-attached]";

const TEXT_MEDIA_TYPES = new Set([
  "application/csv",
  "application/json",
  "application/sql",
  "application/xml",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".csv",
  ".html",
  ".js",
  ".json",
  ".log",
  ".md",
  ".py",
  ".sql",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const WORKBOOK_MEDIA_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const WORKBOOK_EXTENSIONS = new Set([
  ".xls",
  ".xlsx",
]);

const PDF_MEDIA_TYPES = new Set([
  "application/pdf",
]);

const PDF_EXTENSIONS = new Set([
  ".pdf",
]);

const DOCX_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const DOCX_EXTENSIONS = new Set([
  ".docx",
]);

export class AttachmentSerializationError extends Error {
  public constructor(fileName: string, message: string) {
    super(`Failed to serialize attachment ${fileName}: ${message}`);
    this.name = "AttachmentSerializationError";
  }
}

const getFileExtension = (
  fileName: string,
): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
};

const decodeBase64Bytes = (
  value: string,
): Uint8Array => {
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const toArrayBuffer = (
  bytes: Uint8Array,
): ArrayBuffer => {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
};

const trimTrailingNewline = (
  value: string,
): string =>
  value.endsWith("\n") ? value.slice(0, -1) : value;

const buildCodeBlockLines = (
  language: string,
  content: string,
): ReadonlyArray<string> => [
  `\`\`\`${language}`,
  content,
  "```",
];

const getTextDecoder = (): TextDecoder =>
  new TextDecoder("utf-8", { fatal: true });

const decodeUtf8File = (
  part: FileContentPart,
): string => {
  try {
    return getTextDecoder().decode(decodeBase64Bytes(part.base64Data));
  } catch (error) {
    throw new AttachmentSerializationError(
      part.fileName,
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const getAttachmentLabel = (
  part: AttachmentContentPart,
): string =>
  part.type === "file" ? part.fileName : "[image]";

export const isWorkbookAttachment = (
  part: FileContentPart,
): boolean =>
  WORKBOOK_MEDIA_TYPES.has(part.mediaType.toLowerCase())
  || WORKBOOK_EXTENSIONS.has(getFileExtension(part.fileName));

export const isPdfAttachment = (
  part: FileContentPart,
): boolean =>
  PDF_MEDIA_TYPES.has(part.mediaType.toLowerCase())
  || PDF_EXTENSIONS.has(getFileExtension(part.fileName));

export const isDocxAttachment = (
  part: FileContentPart,
): boolean =>
  DOCX_MEDIA_TYPES.has(part.mediaType.toLowerCase())
  || DOCX_EXTENSIONS.has(getFileExtension(part.fileName));

export const isTextFileAttachment = (
  part: FileContentPart,
): boolean => {
  const mediaType = part.mediaType.toLowerCase();
  return mediaType.startsWith("text/")
    || TEXT_MEDIA_TYPES.has(mediaType)
    || TEXT_FILE_EXTENSIONS.has(getFileExtension(part.fileName));
};

export const getMarkdownFenceLanguage = (
  part: FileContentPart,
): string => {
  const extension = getFileExtension(part.fileName);
  if (extension === ".csv") return "csv";
  if (extension === ".html") return "html";
  if (extension === ".js") return "javascript";
  if (extension === ".json") return "json";
  if (extension === ".md") return "markdown";
  if (extension === ".py") return "python";
  if (extension === ".sql") return "sql";
  if (extension === ".ts") return "typescript";
  if (extension === ".xml") return "xml";
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  return "text";
};

export const buildTextFilePromptText = (
  part: FileContentPart,
): string => {
  const rawText = decodeUtf8File(part);
  return [
    `Attached file: ${part.fileName}`,
    ...buildCodeBlockLines(getMarkdownFenceLanguage(part), rawText),
  ].join("\n");
};

export const buildWorkbookPromptText = (
  part: FileContentPart,
): string => {
  try {
    const workbook = XLSX.read(decodeBase64Bytes(part.base64Data), {
      type: "array",
    });
    const sheetBlocks = workbook.SheetNames.flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (sheet === undefined) {
        throw new AttachmentSerializationError(part.fileName, `missing sheet ${sheetName}`);
      }
      const csv = trimTrailingNewline(XLSX.utils.sheet_to_csv(sheet));
      return [
        `Sheet: ${sheetName}`,
        ...buildCodeBlockLines("csv", csv),
      ];
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

const normalizeExtractedText = (
  value: string,
): string => {
  const trimmed = trimTrailingNewline(value).trim();
  return trimmed.length > 0 ? trimmed : "";
};

const extractDocxText = async (
  part: FileContentPart,
): Promise<string> => {
  const data = decodeBase64Bytes(part.base64Data);
  try {
    const result = await mammoth.extractRawText(typeof Buffer !== "undefined"
      ? { buffer: Buffer.from(data) }
      : { arrayBuffer: toArrayBuffer(data) });
    return normalizeExtractedText(result.value);
  } catch (error) {
    throw new AttachmentSerializationError(
      part.fileName,
      error instanceof Error ? error.message : String(error),
    );
  }
};

export const buildDocxPromptText = async (
  part: FileContentPart,
): Promise<string> => {
  const rawText = await extractDocxText(part);
  return [
    `Attached DOCX file: ${part.fileName}`,
    ...buildCodeBlockLines("text", rawText),
  ].join("\n");
};

export const serializeAttachmentForMarkdown = async (
  part: AttachmentContentPart,
): Promise<MarkdownAttachment> => {
  const label = getAttachmentLabel(part);
  if (part.type === "image") {
    return {
      label,
      mediaType: part.mediaType,
      lines: [BINARY_DATA_PLACEHOLDER],
    };
  }

  try {
    if (isTextFileAttachment(part)) {
      return {
        label,
        mediaType: part.mediaType,
        lines: buildCodeBlockLines(getMarkdownFenceLanguage(part), decodeUtf8File(part)),
      };
    }

    if (isWorkbookAttachment(part)) {
      return {
        label,
        mediaType: part.mediaType,
        lines: buildWorkbookPromptText(part).split("\n").slice(1),
      };
    }

    if (isPdfAttachment(part)) {
      return {
        label,
        mediaType: part.mediaType,
        lines: [PDF_OPENAI_NATIVE_PLACEHOLDER],
      };
    }

    if (isDocxAttachment(part)) {
      const text = await extractDocxText(part);
      return {
        label,
        mediaType: part.mediaType,
        lines: text.length > 0
          ? buildCodeBlockLines("text", text)
          : [DOCX_OPENAI_NATIVE_PLACEHOLDER],
      };
    }

    return {
      label,
      mediaType: part.mediaType,
      lines: [BINARY_DATA_PLACEHOLDER],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      label,
      mediaType: part.mediaType,
      lines: [`[attachment extraction failed: ${message}]`],
    };
  }
};
