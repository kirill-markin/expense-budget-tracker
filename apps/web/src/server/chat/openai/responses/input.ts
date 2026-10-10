import { isDeepStrictEqual } from "node:util";
import type OpenAI from "openai";
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
  PdfContentPart,
} from "@/server/chat/types";
import {
  buildDocxPromptText,
  buildTextFilePromptText,
  buildWorkbookPromptText,
  capAttachmentPromptText,
  isCsvAttachment,
  isDocxAttachment,
  isPdfAttachment,
  isTextFileAttachment,
  isWorkbookAttachment,
} from "@/lib/chatAttachments";
import { getPdfDerivedImageByteLength } from "@/lib/chatPdf";
import { CHAT_SENT_INPUT_BUDGET_TOKENS } from "@/lib/chatModels";
import { planChatHistoryReplay } from "@/server/chat/openai/responses/history";
import {
  normalizeStoredOpenAIReplayItems,
  replayItemsFromCompaction,
  toOpenAIResponseInputItem,
  type ServerChatMessage,
} from "@/server/chat/openai/responses/replayItems";
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
    const fileName = part.type === "image" ? null : part.fileName;
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

/** Extracted text for every format we can read; `null` for opaque binaries. */
const buildExtractedFilePromptText = async (
  part: FileContentPart,
): Promise<string | null> => {
  if (isCsvAttachment(part) || isTextFileAttachment(part)) {
    return buildTextFilePromptText(part);
  }

  if (isWorkbookAttachment(part)) {
    return buildWorkbookPromptText(part);
  }

  if (isDocxAttachment(part)) {
    return buildDocxPromptText(part);
  }

  return null;
};

/**
 * Maps a persisted attachment back into the exact content shape we want to
 * resend to the model on later turns.
 *
 * The policy is intentionally format-aware. Every format we can extract is sent
 * as extracted text alone: the original bytes would be a second, billed copy of
 * the same content on every turn.
 * - CSV files -> `input_text` only
 * - other text-like files -> extracted text `input_text` only
 * - workbooks -> extracted CSV text `input_text` only
 * - DOCX -> extracted raw text `input_text` only
 * - images -> native `input_image`
 * - logical PDFs -> ordered extracted-text + JPEG page pairs
 * - legacy raw PDFs -> rejected before model input construction
 * - other binaries -> native `input_file` only
 */
const isContainerAttachmentPart = (
  part: ContentPart,
): part is FileContentPart =>
  part.type === "file" && (isWorkbookAttachment(part) || isDocxAttachment(part));

/**
 * How much container extraction one sizing pass may do.
 *
 * Both limits are in DECOMPRESSED bytes, because that is what the work is linear
 * in: a `.xlsx` is a ZIP, and measured extraction runs about 55-60 ms per
 * megabyte of sheet XML - 7 ms for a 90 KB workbook, 19 ms at 325 KB, 49 ms at
 * 800 KB, 174 ms at 3.3 MB. A compressed-byte gate bounds nothing: a well-formed
 * 250 KB workbook can hold a 73.5 MB sheet and take 4.5 seconds of fully
 * synchronous `XLSX.read` plus `sheet_to_csv`, blocking the event loop for every
 * user on the task.
 *
 * Per container, 1 MiB keeps one file near 60 ms and still covers an ordinary
 * export - a 5,000-row, four-column sheet is 800 KB uncompressed. Across the
 * pass, 2 MiB bounds it near 120 ms.
 *
 * A total budget rather than a count: a count cap was measured re-opening the
 * very defect this sizing exists to close, because every container it skipped
 * fell back to the cap. With a cap of four, a 40-message session carrying five
 * two-cell workbooks - 800 real tokens each - sized at 122,282 and dropped two
 * messages; six sized at 182,306; eight at 302,354 and dropped six. Under a byte
 * budget all eight are sized exactly, and only genuinely large ones fall back.
 *
 * Note what is and is not new here. The replay path has always extracted every
 * container it sends, with no gate at all, and still does: that stall is
 * pre-existing and these limits do not change it. What the sizing pass added was
 * extracting containers the window is about to drop - that is what these bound.
 *
 * Two accepted costs, both of them over-charges rather than under-charges:
 *
 * - A container the budget excludes is charged the extracted-text cap, 357,167
 *   tokens against a 120,000 budget, so no cut reaches through its message and
 *   the window drops it along with the history before it. It stays that way until that message is replayed and measured,
 *   and a stored container the window never replays is never measured at all.
 *   The durable fix is persisting the extracted length when the attachment is
 *   stored, the way a PDF's page text already is, which is item 06/07.
 * - The budget also excludes containers the window would have replayed happily.
 *   The crossover sits around 6,300 rows by four columns, and a real Excel file
 *   deflates about 10:1, so a 100-150 KB `.xlsx` can already declare more than
 *   1 MiB uncompressed and fall back to its cap.
 * - The standing limit of this whole approach: against a reader that ignores
 *   declared sizes, no directory-only bound is sound. JSZip - the DOCX path - is
 *   such a reader, so a deflated entry declaring 100 bytes inflates in full
 *   whatever this gate computed. It is unreachable today only because `mammoth`
 *   throws on every `.docx` before reaching that point, which is luck rather
 *   than design. Persisting the extracted length when the attachment is stored
 *   is what actually closes it, and that is the same item 06/07 above - this is
 *   the reason the DOCX path needs it rather than merely benefiting from it.
 */
const CONTAINER_SIZING_MAXIMUM_UNCOMPRESSED_BYTES = 1_048_576;
const CONTAINER_SIZING_TOTAL_UNCOMPRESSED_BUDGET_BYTES = 2_097_152;

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_HEADER_BYTES = 46;
const ZIP_LOCAL_FILE_HEADER_BYTES = 30;
const ZIP_STORED_METHOD = 0;
const ZIP64_SENTINEL = 0xffffffff;

/**
 * Entries whose content is work a reader will really do.
 *
 * Only media is excluded, and for both formats alike. A workbook reader parses
 * every sheet plus the shared strings, styles and chart parts, and never turns
 * `xl/media` into CSV; `mammoth` resolves a DOCX's main part through
 * `_rels/.rels` - `word/document.xml` is only its fallback, and real producers
 * emit `word/document2.xml` - and also reads `word/styles.xml`,
 * `word/numbering.xml`, `word/footnotes.xml`, `word/endnotes.xml` and
 * `word/comments.xml`. Scoping to `word/document.xml` sized a non-standard main
 * part at zero and left footnote, endnote and comment bodies uncounted, which is
 * the dangerous direction. Excluding media alone needs no knowledge of either
 * reader's internals.
 */
const isSizeableZipEntry = (
  entryName: string,
): boolean =>
  !entryName.startsWith("xl/media/") && !entryName.startsWith("word/media/");

/**
 * Offset of the end-of-central-directory record, found by scanning the tail
 * rather than by trusting the first four bytes.
 *
 * A ZIP is defined by this record, not by a leading signature: readers open an
 * archive with bytes prepended to it, and `mediaType` and the file extension are
 * both client-controlled. A measured 165,923 byte `.docx` with a two byte prefix
 * took the "not a ZIP, use the stored length" branch and was admitted while
 * holding 48,600,151 bytes of `document.xml`; under a megabyte a crafted file
 * reached some 300 MB and seconds of blocked event loop.
 */
const findZipEndOfCentralDirectory = (
  view: DataView,
  bytes: Uint8Array,
): number | null => {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  return null;
};

type ZipEntry = Readonly<{
  name: string;
  declaredBytes: number;
  localOffset: number;
  dataStart: number;
}>;

/**
 * Every size field of one entry, from both of its headers, or `null` when the
 * entry is malformed.
 *
 * All four fields are read, not just the two uncompressed ones. For a STORED
 * entry a reader takes the data as it lies rather than the declared
 * uncompressed size, and every one of these fields is client-controlled: a
 * 14,887,753 byte `.xlsx` holding one stored 14,881,877 byte sheet with its
 * uncompressed sizes rewritten to 100 was sized 14,334, admitted, and then took
 * 646 ms of synchronous work per turn. A stored entry whose compressed and
 * uncompressed sizes disagree is malformed by definition and is refused rather
 * than sized.
 */
const readZipEntry = (
  view: DataView,
  bytes: Uint8Array,
  entryOffset: number,
  localHeaderDelta: number,
  name: string,
): ZipEntry | null => {
  const centralMethod = view.getUint16(entryOffset + 10, true);
  const centralCompressedBytes = view.getUint32(entryOffset + 20, true);
  const centralUncompressedBytes = view.getUint32(entryOffset + 24, true);
  const localOffset = view.getUint32(entryOffset + 42, true) + localHeaderDelta;
  if (
    centralCompressedBytes === ZIP64_SENTINEL
    || centralUncompressedBytes === ZIP64_SENTINEL
    || localOffset < 0
    || localOffset + ZIP_LOCAL_FILE_HEADER_BYTES > bytes.length
    || view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER
  ) {
    return null;
  }

  const localMethod = view.getUint16(localOffset + 8, true);
  const localCompressedBytes = view.getUint32(localOffset + 18, true);
  const localUncompressedBytes = view.getUint32(localOffset + 22, true);
  if (localCompressedBytes === ZIP64_SENTINEL || localUncompressedBytes === ZIP64_SENTINEL) {
    return null;
  }

  const isStored = centralMethod === ZIP_STORED_METHOD
    || localMethod === ZIP_STORED_METHOD;
  if (
    isStored
    && (centralCompressedBytes !== centralUncompressedBytes
      || localCompressedBytes !== localUncompressedBytes)
  ) {
    return null;
  }

  return {
    name,
    declaredBytes: Math.max(
      centralUncompressedBytes,
      centralCompressedBytes,
      localUncompressedBytes,
      localCompressedBytes,
    ),
    localOffset,
    dataStart: localOffset
      + ZIP_LOCAL_FILE_HEADER_BYTES
      + view.getUint16(localOffset + 26, true)
      + view.getUint16(localOffset + 28, true),
  };
};

const decodeZipEntryName = (
  bytes: Uint8Array,
  entryOffset: number,
  nameLength: number,
): string =>
  new TextDecoder("utf-8").decode(
    bytes.subarray(
      entryOffset + ZIP_CENTRAL_DIRECTORY_ENTRY_HEADER_BYTES,
      entryOffset + ZIP_CENTRAL_DIRECTORY_ENTRY_HEADER_BYTES + nameLength,
    ),
  );

/**
 * Walks the central directory, or returns `null` for an archive whose structure
 * does not hold together.
 *
 * Every bound here is checked because every number here is attacker-steerable.
 * The directory is read at `endOfDirectory - directorySize` rather than at the
 * offset it declares, the declared offset only has to be consistent with that,
 * the walk has to consume the directory exactly and finish at the record it
 * started from, and the entry count has to match what was walked. Without those:
 * a 22 byte fake end record appended to an honest 15 MB workbook, with
 * `directorySize` chosen to land inside a stored file's data, had its "entries"
 * verified against the attacker's own bytes and sized 1,114; an entry count of
 * zero sized 0; and a truncated count sized 0 while JSZip ignores the count
 * entirely and walks by signature.
 */
const readZipEntries = (
  view: DataView,
  bytes: Uint8Array,
  endOfDirectory: number,
): ReadonlyArray<ZipEntry> | null => {
  const entryCount = view.getUint16(endOfDirectory + 10, true);
  const directorySize = view.getUint32(endOfDirectory + 12, true);
  const declaredDirectoryOffset = view.getUint32(endOfDirectory + 16, true);
  const directoryStart = endOfDirectory - directorySize;
  const delta = directoryStart - declaredDirectoryOffset;
  if (entryCount === 0 || directorySize === 0 || directoryStart < 0 || delta < 0) {
    return null;
  }

  const entries: Array<ZipEntry> = [];
  let entryOffset = directoryStart;
  while (entryOffset < endOfDirectory) {
    if (
      entryOffset + ZIP_CENTRAL_DIRECTORY_ENTRY_HEADER_BYTES > endOfDirectory
      || view.getUint32(entryOffset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY
    ) {
      return null;
    }

    const nameLength = view.getUint16(entryOffset + 28, true);
    const entry = readZipEntry(
      view,
      bytes,
      entryOffset,
      delta,
      decodeZipEntryName(bytes, entryOffset, nameLength),
    );
    if (entry === null) {
      return null;
    }

    entries.push(entry);
    entryOffset += ZIP_CENTRAL_DIRECTORY_ENTRY_HEADER_BYTES
      + nameLength
      + view.getUint16(entryOffset + 30, true)
      + view.getUint16(entryOffset + 32, true);
  }

  return entryOffset === endOfDirectory && entries.length === entryCount
    ? entries
    : null;
};

/**
 * Where each distinct local header's data ends: at the next header, or at the
 * directory for the last one.
 *
 * Built once, by sorting the distinct offsets, because the lookup is per entry
 * and the entry count is attacker-chosen. Scanning the offsets per entry made it
 * quadratic, and nothing stops a directory from pointing all of its entries at
 * one 30 byte local header: 65,535 of them - a 3 MB file - cost 2,282 ms, which
 * the gate could not bound because it is spent before any admission test, sized
 * 0 against the pass budget, and re-paid on every later turn of the session.
 */
const buildNextHeaderOffsets = (
  entries: ReadonlyArray<ZipEntry>,
  directoryStart: number,
): ReadonlyMap<number, number> => {
  const offsets = [...new Set(entries.map((entry) => entry.localOffset))]
    .sort((left, right) => left - right);

  return new Map(offsets.map((offset, index) => [
    offset,
    offsets[index + 1] ?? directoryStart,
  ]));
};

/**
 * Bytes an entry could really yield: the largest of its four declared sizes and
 * the space its data actually occupies, which is what a reader of a STORED entry
 * takes. A gap between entries over-charges slightly - the safe direction - and
 * a declared size larger than the space available is still honoured, since that
 * is what inflating would produce.
 *
 * The extent term is belt and braces over the max-of-four-declared-sizes bound,
 * and it can only ever raise a charge, never lower one. It is bypassable: a fake
 * 30 byte local header planted inside a stored entry's data under an
 * `xl/media/` name truncates that entry's extent to 64 bytes while the decoy's
 * own extent is dropped by the media filter, which returns a 14,887,813 byte
 * file holding a 14.88 MB stored sheet to a charge of 14,334 (the same file with
 * a non-media decoy name is refused at 14,896,117). There is no exploitation
 * path today: the sizes it must declare to arrange that are the sizes a reader
 * then honours, so no reader takes more than those 100 bytes, and SheetJS
 * rejects both shapes in 4-7 ms.
 */
const entryUncompressedByteLength = (
  entry: ZipEntry,
  nextHeaderOffsets: ReadonlyMap<number, number>,
  directoryStart: number,
): number => {
  const nextHeader = nextHeaderOffsets.get(entry.localOffset) ?? directoryStart;

  return Math.max(entry.declaredBytes, nextHeader - entry.dataStart, 0);
};

/**
 * Inflated bytes the entries a reader will parse could yield, or `null` when the
 * archive cannot be read this way - a ZIP64 container, a malformed entry, or a
 * directory whose structure does not hold together.
 *
 * `null` means "do not extract this", not "fall back to the stored length": the
 * stored length of a ZIP says nothing about its contents, and a 300 KB ZIP64
 * `.xlsx` holding 70 MB of sheet XML would otherwise pass a 1 MiB gate.
 */
export const readZipUncompressedByteLength = (
  bytes: Uint8Array,
): number | null => {
  if (bytes.length < 22) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOfDirectory = findZipEndOfCentralDirectory(view, bytes);
  if (endOfDirectory === null) {
    return null;
  }

  const entries = readZipEntries(view, bytes, endOfDirectory);
  if (entries === null) {
    return null;
  }

  const directoryStart = endOfDirectory - view.getUint32(endOfDirectory + 12, true);
  const nextHeaderOffsets = buildNextHeaderOffsets(entries, directoryStart);

  return entries
    .filter((entry) => isSizeableZipEntry(entry.name))
    .reduce(
      (total, entry) => total
        + entryUncompressedByteLength(entry, nextHeaderOffsets, directoryStart),
      0,
    );
};

/**
 * Inflated size of one container, or `null` when it cannot be established and
 * the container must not be extracted on this path. A file with no
 * end-of-central-directory record at all is not a ZIP - a legacy `.xls` stores
 * its sheets uncompressed - so its own length is the work.
 */
const containerUncompressedByteLength = (
  part: FileContentPart,
): number | null => {
  const bytes = Uint8Array.from(Buffer.from(part.base64Data, "base64"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || findZipEndOfCentralDirectory(view, bytes) === null) {
    return bytes.length;
  }

  return readZipUncompressedByteLength(bytes);
};

/**
 * Stored containers the extraction budget admits, newest first, returned in
 * history order. The budget is the only bound on this set: the newest
 * attachments are the ones a window is likeliest to replay, and an older one the
 * budget excludes falls back to its cap.
 */
const selectStoredContainerPartsForSizing = (
  history: ReadonlyArray<ServerChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const candidates = history
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content)
    .filter(isContainerAttachmentPart);
  const selected: Array<FileContentPart> = [];
  let budgetBytes = CONTAINER_SIZING_TOTAL_UNCOMPRESSED_BUDGET_BYTES;
  for (const part of [...candidates].reverse()) {
    const uncompressedBytes = containerUncompressedByteLength(part);
    if (
      uncompressedBytes === null
      || uncompressedBytes > CONTAINER_SIZING_MAXIMUM_UNCOMPRESSED_BYTES
      || uncompressedBytes > budgetBytes
    ) {
      continue;
    }

    budgetBytes -= uncompressedBytes;
    selected.unshift(part);
  }

  return selected;
};

const selectContainerPartsForSizing = (
  history: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): ReadonlyArray<FileContentPart> => [
  ...selectStoredContainerPartsForSizing(history),
  // The current turn's containers are outside the budget: this request sends
  // them, so it extracts them whatever their size, and the only question is
  // whether the window sees the result first.
  ...turnInput.filter(isContainerAttachmentPart),
];

/**
 * Extracted prompt text of those containers, keyed by the part. A workbook or a
 * DOCX is a container, so its bytes say nothing about the text it replays as,
 * and the history window has to size it before this request is built - while
 * this very request extracts it anyway. Extracting once here serves both, so the
 * window charges exactly the string that is sent and the build below does not
 * parse the same file a second time.
 *
 * Only containers are prepared: text and CSV attachments replay as their own
 * bytes, which sizing already reads correctly, and extracting them here would be
 * work for nothing.
 *
 * An extraction failure is reported and left out of the map rather than raised,
 * so this sizing step cannot change which error a malformed attachment produces:
 * the part falls back to its bound for sizing, and if it is replayed the build
 * raises the real `AttachmentSerializationError` as it always did.
 */
/** Exposed for the direct tests of the budget's selection rules. */
export const selectContainerPartsForSizingForTest = (
  history: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): ReadonlyArray<FileContentPart> =>
  selectContainerPartsForSizing(history, turnInput);

const prepareContainerAttachmentText = async (
  parts: ReadonlyArray<FileContentPart>,
  sessionId: string,
  requestId: string,
): Promise<ReadonlyMap<ContentPart, string>> => {
  const prepared = new Map<ContentPart, string>();
  for (const part of parts) {
    try {
      const promptText = await buildExtractedFilePromptText(part);
      if (promptText !== null) {
        prepared.set(part, capAttachmentPromptText(part.fileName, promptText));
      }
    } catch (error) {
      log({
        domain: "chat",
        action: "attachment_sizing_extraction_failed",
        vendor: "openai",
        requestId,
        sessionId,
        mediaType: part.mediaType,
        sizeBytes: Math.ceil((part.base64Data.length * 3) / 4),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return prepared;
};

const mapAttachmentPart = async (
  part: ImageContentPart | FileContentPart | PdfContentPart,
  preparedText: string | undefined,
): Promise<ReadonlyArray<OpenAIInputContent>> => {
  switch (part.type) {
    case "image":
      return [{
        type: "input_image",
        detail: "auto",
        image_url: `data:${part.mediaType};base64,${part.base64Data}`,
      }];
    case "pdf":
      return mapPdfAttachmentPart(part);
    case "file": {
      if (isPdfAttachment(part)) {
        throw new LegacyPdfFileAttachmentError(0, part.mediaType, part.fileName);
      }

      // Already extracted for sizing: extracting a container twice per turn
      // would double the only expensive step in this path.
      if (preparedText !== undefined) {
        return [{ type: "input_text", text: preparedText }];
      }

      const promptText = await buildExtractedFilePromptText(part);
      if (promptText === null) {
        return [{
          type: "input_file",
          filename: part.fileName,
          file_data: buildFileDataUrl(part),
        }];
      }

      return [{
        type: "input_text",
        text: capAttachmentPromptText(part.fileName, promptText),
      }];
    }
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

const mapMessagePart = async (
  part: ContentPart,
  preparedAttachmentText: ReadonlyMap<ContentPart, string> | undefined,
): Promise<ReadonlyArray<OpenAIInputContent>> => {
  if (part.type === "text") {
    return [{ type: "input_text", text: part.text }];
  }

  if (part.type === "image" || part.type === "file" || part.type === "pdf") {
    return await mapAttachmentPart(part, preparedAttachmentText?.get(part));
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
  part: FileContentPart | ImageContentPart | PdfContentPart,
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

    return replayableItems.map(toOpenAIResponseInputItem);
  }

  return [];
};

const buildUserInputMessage = async (
  content: ReadonlyArray<ContentPart>,
  preparedAttachmentText?: ReadonlyMap<ContentPart, string>,
): Promise<OpenAIInputItem> => ({
  role: "user",
  type: "message",
  content: (await Promise.all(
    content.map(async (part) => await mapMessagePart(part, preparedAttachmentText)),
  )).flat(),
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
   * the token budget for this whole input allows. Container attachments - this
   * turn's, and the stored ones the window could still replay - are extracted
   * before that decision so the budget charges them the text they really send,
   * and every extraction is reused when the history is rendered below.
   */
  const normalizedHistory = normalizeHistoryMessages(localMessages, turnInput);
  const attachmentText = await prepareContainerAttachmentText(
    selectContainerPartsForSizing(normalizedHistory, turnInput),
    sessionId,
    requestId,
  );
  const plan = planChatHistoryReplay(normalizedHistory, turnInput, attachmentText);
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
      ));
      continue;
    }

    if (message.content.length === 0) {
      continue;
    }
    input.push(await buildUserInputMessage(message.content, attachmentText));
  }

  input.push(await buildUserInputMessage(turnInput, attachmentText));

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
