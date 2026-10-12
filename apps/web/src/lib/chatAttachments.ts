import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { getChatDocumentFileName, UnnamedChatFilePathError } from "@/lib/chatFiles";
import {
  isInlineFileContentPart,
  type FileContentPart,
  type ImageContentPart,
  type InlineFileContentPart,
  type PdfContentPart,
} from "@/server/chat/types";

/**
 * Attachment rendering of the Copy-transcript export.
 *
 * Nothing here feeds model input. A document is a file of the session the model
 * reads with `bash`, and the browser is sent its name and none of its bytes, so
 * the export names the file instead of rendering contents it does not hold. It
 * cannot read the object either: the page's `connect-src 'self'` admits no
 * request to the store the pre-signed read URL points at, and the host of that
 * store is this deployment's own setting.
 *
 * The extraction below therefore has one subject left, an attachment still
 * inline in the browser's own copy of a turn it has just sent, whose bytes are
 * in hand. That send is what item 08 replaces, and this goes with it.
 *
 * Markdown export behavior:
 * - A document reloaded from the server renders as `[no-document-contents]`.
 * - A document that is already a file of the session renders as that file.
 * - Text-like inline files render as fenced code/text blocks.
 * - Inline XLS/XLSX render as per-sheet CSV blocks.
 * - Inline DOCX renders as extracted raw text, or `[no-extractable-text]` when
 *   the file carries none.
 * - Images render as `[binary-data]`.
 * - Logical PDFs render extracted text plus a marker for each rendered page image.
 * - Other opaque binaries render as `[binary-data]`.
 */
export type AttachmentContentPart =
  | FileContentPart
  | InlineFileContentPart
  | ImageContentPart
  | PdfContentPart;

export type MarkdownAttachment = Readonly<{
  label: string;
  mediaType: string;
  lines: ReadonlyArray<string>;
}>;

export const BINARY_DATA_PLACEHOLDER = "[binary-data]";
/**
 * A document this copy of the transcript holds no bytes of: every document of a
 * reloaded message, because the snapshot carries the name alone.
 */
export const DOCUMENT_NO_CONTENTS_PLACEHOLDER = "[no-document-contents]";
export const PDF_RENDERED_PAGE_PLACEHOLDER = "[rendered-page-image]";
export const PDF_MISSING_TEXT_PLACEHOLDER = "[no-embedded-text]";
export const DOCX_MISSING_TEXT_PLACEHOLDER = "[no-extractable-text]";

/** Name and declared type of one attachment, which is what the format predicates read. */
type AttachmentDescriptor = Readonly<{
  fileName: string;
  mediaType: string;
}>;

const CSV_MEDIA_TYPES = new Set([
  "application/csv",
  "text/csv",
]);

const CSV_FILE_EXTENSIONS = new Set([
  ".csv",
]);

const TEXT_MEDIA_TYPES = new Set([
  ...CSV_MEDIA_TYPES,
  "application/json",
  "application/sql",
  "application/xml",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ...CSV_FILE_EXTENSIONS,
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

const decodeUtf8 = (
  bytes: Uint8Array,
): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const describeAttachment = (
  part: FileContentPart | InlineFileContentPart,
): AttachmentDescriptor => ({
  fileName: getChatDocumentFileName(part),
  mediaType: part.mediaType,
});

export const getAttachmentLabel = (
  part: AttachmentContentPart,
): string => {
  if (part.type === "image") {
    return "[image]";
  }

  return part.type === "pdf" ? part.fileName : describeAttachment(part).fileName;
};

/** Label of an attachment whose own name cannot be read. */
const UNNAMED_ATTACHMENT_LABEL = "[unnamed-attachment]";

/**
 * The same label for the export, which may not fail over one attachment.
 *
 * Reading the name of a reference part raises for a path that carries none, and
 * the export is one string built from every attachment of the transcript, so
 * such a part has to cost its own label rather than the whole copy. That raise
 * alone is answered with the label: anything else is a part this module cannot
 * read at all, and is raised rather than exported as an unnamed attachment.
 */
const readAttachmentLabel = (
  part: AttachmentContentPart,
): string => {
  try {
    return getAttachmentLabel(part);
  } catch (error) {
    if (!(error instanceof UnnamedChatFilePathError)) {
      throw error;
    }

    return UNNAMED_ATTACHMENT_LABEL;
  }
};

const isWorkbookAttachment = (
  descriptor: AttachmentDescriptor,
): boolean =>
  WORKBOOK_MEDIA_TYPES.has(descriptor.mediaType.toLowerCase())
  || WORKBOOK_EXTENSIONS.has(getFileExtension(descriptor.fileName));

const isDocxAttachment = (
  descriptor: AttachmentDescriptor,
): boolean =>
  DOCX_MEDIA_TYPES.has(descriptor.mediaType.toLowerCase())
  || DOCX_EXTENSIONS.has(getFileExtension(descriptor.fileName));

const isTextFileAttachment = (
  descriptor: AttachmentDescriptor,
): boolean => {
  const mediaType = descriptor.mediaType.toLowerCase();
  return mediaType.startsWith("text/")
    || TEXT_MEDIA_TYPES.has(mediaType)
    || TEXT_FILE_EXTENSIONS.has(getFileExtension(descriptor.fileName));
};

const getMarkdownFenceLanguage = (
  descriptor: AttachmentDescriptor,
): string => {
  const extension = getFileExtension(descriptor.fileName);
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

const buildWorkbookCsvLines = (
  descriptor: AttachmentDescriptor,
  bytes: Uint8Array,
): ReadonlyArray<string> => {
  try {
    const workbook = XLSX.read(bytes, { type: "array" });
    return workbook.SheetNames.flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (sheet === undefined) {
        throw new AttachmentSerializationError(descriptor.fileName, `missing sheet ${sheetName}`);
      }
      const csv = trimTrailingNewline(XLSX.utils.sheet_to_csv(sheet));
      return [
        `Sheet: ${sheetName}`,
        ...buildCodeBlockLines("csv", csv),
      ];
    });
  } catch (error) {
    if (error instanceof AttachmentSerializationError) {
      throw error;
    }

    throw new AttachmentSerializationError(
      descriptor.fileName,
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
  descriptor: AttachmentDescriptor,
  bytes: Uint8Array,
): Promise<string> => {
  try {
    const result = await mammoth.extractRawText(typeof Buffer !== "undefined"
      ? { buffer: Buffer.from(bytes) }
      : { arrayBuffer: toArrayBuffer(bytes) });
    return normalizeExtractedText(result.value);
  } catch (error) {
    throw new AttachmentSerializationError(
      descriptor.fileName,
      error instanceof Error ? error.message : String(error),
    );
  }
};

/** What a document that is a file of the session reads as in the export. */
const buildStoredDocumentLines = (
  part: FileContentPart,
): ReadonlyArray<string> => [
  `[chat file ${JSON.stringify(part.path)}, ${String(part.sizeBytes)} bytes]`,
];

const buildDocumentLines = async (
  descriptor: AttachmentDescriptor,
  bytes: Uint8Array,
): Promise<ReadonlyArray<string>> => {
  // Nothing to extract, and the two cases that reach it are the same fact about
  // this copy of the message: a reloaded document is named and empty, and a
  // file the user attached empty has no contents either.
  if (bytes.byteLength === 0) {
    return [DOCUMENT_NO_CONTENTS_PLACEHOLDER];
  }

  if (isTextFileAttachment(descriptor)) {
    try {
      return buildCodeBlockLines(getMarkdownFenceLanguage(descriptor), decodeUtf8(bytes));
    } catch (error) {
      throw new AttachmentSerializationError(
        descriptor.fileName,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (isWorkbookAttachment(descriptor)) {
    return buildWorkbookCsvLines(descriptor, bytes);
  }

  if (isDocxAttachment(descriptor)) {
    const text = await extractDocxText(descriptor, bytes);
    return text.length > 0
      ? buildCodeBlockLines("text", text)
      : [DOCX_MISSING_TEXT_PLACEHOLDER];
  }

  return [BINARY_DATA_PLACEHOLDER];
};

export const serializeAttachmentForMarkdown = async (
  part: AttachmentContentPart,
): Promise<MarkdownAttachment> => {
  const label = readAttachmentLabel(part);
  if (part.type === "pdf") {
    return {
      label,
      mediaType: part.mediaType,
      lines: part.pages.flatMap((page) => [
        `Page ${String(page.pageNumber)}`,
        ...(page.text.length === 0
          ? [PDF_MISSING_TEXT_PLACEHOLDER]
          : buildCodeBlockLines("text", page.text)),
        PDF_RENDERED_PAGE_PLACEHOLDER,
      ]),
    };
  }
  if (part.type === "image") {
    return {
      label,
      mediaType: part.mediaType,
      lines: [BINARY_DATA_PLACEHOLDER],
    };
  }

  if (!isInlineFileContentPart(part)) {
    return {
      label,
      mediaType: part.mediaType,
      lines: buildStoredDocumentLines(part),
    };
  }

  try {
    return {
      label,
      mediaType: part.mediaType,
      lines: await buildDocumentLines(
        describeAttachment(part),
        decodeBase64Bytes(part.base64Data),
      ),
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
