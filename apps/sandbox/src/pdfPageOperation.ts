/**
 * One page of one PDF, as a PDF of its own.
 *
 * A text derivative cannot carry a chart, a stamp or a scanned line, so the one
 * thing left is to put the page itself in front of the model. It travels as a
 * one-page PDF rather than as a rendered image because that needs no canvas,
 * no font files and no raster step: the page's own objects are copied across
 * and whoever displays it renders it.
 *
 * The answer is bounded by SANDBOX_PDF_PAGE_MAX_BYTES, which is a property of
 * the transport rather than of this code: a Lambda RequestResponse payload is
 * capped at 6 MB and base64 inflates the page by 4/3.
 */
import {
  quoteUntrustedSandboxText,
  quoteUntrustedSandboxValue,
  SANDBOX_PDF_PAGE_MAX_BYTES,
  type ChatSandboxPdfPageRequest,
  type ChatSandboxPdfPageResponse,
} from "./contract.js";
import {
  createPresignedObjectTransfer,
  requireDescribedObject,
  type SandboxObjectTransfer,
} from "./objects.js";

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Copy one page out, or say why it could not be answered.
 *
 * Every refusal is a response rather than a raised error, and that is the whole
 * shape of this function: the page number is the model's, so asking for page 40
 * of a 3-page statement is a thing to be told, not a failed invocation that
 * reaches the caller as a dead Lambda and pages on its own log record. Page 0
 * is the same thing from the other side, which is why the request schema bounds
 * the field to a whole number and leaves both ends to this check. The page
 * count travels with both answers for the same reason - it is the only way the
 * model learns which page it may ask for next.
 *
 * Exported with the transfer as a port, the way diffWorkFiles is, so the copy
 * is driven without a network.
 */
export const extractPdfPage = async (
  request: ChatSandboxPdfPageRequest,
  transfer: SandboxObjectTransfer,
): Promise<ChatSandboxPdfPageResponse> => {
  const startedAt = Date.now();
  const quotedPath = quoteUntrustedSandboxValue(request.source.path);
  try {
    // Verified against the row the request came from, exactly as a /files read
    // is: a page taken from bytes the chat was told it is not reading would be
    // another document rendered under this one's name.
    const bytes = requireDescribedObject(
      request.source.path,
      await transfer.readObject(request.source.getUrl),
      request.source,
    );
    const { PDFDocument } = await import("pdf-lib");
    const source = await PDFDocument.load(bytes);
    const pageCount = source.getPageCount();
    if (request.page < 1 || request.page > pageCount) {
      return {
        status: "failed",
        error: `${quotedPath} has ${String(pageCount)} pages, so page ${String(request.page)} is not one of them`,
        durationMs: Date.now() - startedAt,
      };
    }

    const onePage = await PDFDocument.create();
    const [copied] = await onePage.copyPages(source, [request.page - 1]);
    onePage.addPage(copied);
    const pageBytes = await onePage.save();
    if (pageBytes.byteLength > SANDBOX_PDF_PAGE_MAX_BYTES) {
      return {
        status: "failed",
        error: `page ${String(request.page)} of ${quotedPath} is ${String(pageBytes.byteLength)} bytes on its own, past the ${String(SANDBOX_PDF_PAGE_MAX_BYTES)} bytes one page may be returned as: it carries more than a page of a statement does, so read the text beside the file instead`,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      status: "rendered",
      page: request.page,
      pageCount,
      pdfBase64: Buffer.from(pageBytes).toString("base64"),
      sizeBytes: pageBytes.byteLength,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "failed",
      // An encrypted or truncated PDF arrives here as the library's own
      // message, which quotes nothing itself and was built around a path the
      // chat supplied.
      error: `page ${String(request.page)} of ${quotedPath} could not be read: ${quoteUntrustedSandboxText(describeError(error))}`,
      durationMs: Date.now() - startedAt,
    };
  }
};

export const runChatSandboxPdfPage = async (
  request: ChatSandboxPdfPageRequest,
  deadlineEpochMs: number,
): Promise<ChatSandboxPdfPageResponse> =>
  extractPdfPage(request, createPresignedObjectTransfer(deadlineEpochMs));
