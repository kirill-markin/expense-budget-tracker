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
import { loadConversionLibrary } from "./conversionLibrary.js";
import {
  classifyObjectReadFailure,
  createPresignedObjectTransfer,
  describeObjectReadFailure,
  requireDescribedObject,
  runObjectReadDirectly,
  type SandboxObjectTransfer,
} from "./objects.js";
import { isSandboxDefect } from "./sandboxDefect.js";

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Copy one page out, or say why it could not be answered.
 *
 * Almost every refusal is a response rather than a raised error, and that is
 * the shape of this function: the page number is the model's, so asking for
 * page 40 of a 3-page statement is a thing to be told, not a failed invocation
 * that reaches the caller as a dead Lambda and pages on its own log record.
 * Page 0 is the same thing from the other side, which is why the request schema
 * bounds the field to a whole number and leaves both ends to this check. The
 * page count travels with both answers for the same reason - it is the only way
 * the model learns which page it may ask for next.
 *
 * Two things are not that, and both were answers until they were measured
 * against what the answer says. A failed read gets the advice its kind gets
 * everywhere else in this sandbox, because "page 1 could not be read: HTTP 503"
 * tells a model nothing it can act on while "this is transient, ask for it
 * again" does. And a fault of this sandbox is raised, because it is not a
 * property of this page or this document: a pdf-lib this build cannot load
 * fails every PDF of the deployment, forever, on invocations that all report
 * success - no Errors datapoint, no derivatives_error row, nothing in any log
 * that says anything but "page 1 could not be read" - and a TypeError of this
 * workspace's own is the same thing with a different cause. A raise is the only
 * channel that leaves a trace, and the model has nothing to lose by it: the
 * model's retry cannot fix a bundle.
 *
 * Which fault that is, both catches ask sandboxDefect.ts, the predicate
 * `prepare` asks. The two operations read the same objects over the same
 * transfer and load libraries the same way, so an error class that is this
 * sandbox's fault in one of them is this sandbox's fault in the other.
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
  let bytes: Uint8Array;
  try {
    // Verified against the row the request came from, exactly as a /files read
    // is: a page taken from bytes the chat was told it is not reading would be
    // another document rendered under this one's name.
    bytes = requireDescribedObject(
      request.source.path,
      await transfer.readObject(request.source.getUrl),
      request.source,
    );
  } catch (error) {
    // The same question `prepare` asks of the same read, and asked first for
    // the same reason: classifyObjectReadFailure calls a bug of this
    // workspace's own `unknown`, so without this the model would be told a
    // TypeError here is a transient storage failure and to ask again, for as
    // long as the bug exists, with nothing anywhere saying the sandbox is
    // broken. One predicate for both operations, because an answer that
    // depended on which of them raised it would be the divergence itself.
    if (isSandboxDefect(error)) {
      throw error;
    }

    return {
      status: "failed",
      // The file and not the page is the subject here, and deliberately: the
      // page number had nothing to do with this and the advice is about the
      // read. It is the same text a refused /files read gets in a `bash`
      // command's notes, because this is a refused /files read; objects.ts owns
      // it, beside the kinds it is keyed by.
      error: `${quotedPath} ${describeObjectReadFailure(classifyObjectReadFailure(error))} (${quoteUntrustedSandboxText(describeError(error))})`,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const PDFDocument = await loadConversionLibrary(
      "pdf-lib",
      async () => (await import("pdf-lib")).PDFDocument,
    );
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
    // The things here that are not about this document: a pdf-lib this build
    // cannot load, per the note above, and a bug of this workspace's own, which
    // would otherwise be answered as a page that could not be read.
    if (isSandboxDefect(error)) {
      throw error;
    }

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

/**
 * The operation with its real transfer, in whichever process is running it.
 *
 * Not the entry point the Lambda reaches: handler.ts sends a `pdf_page` to the
 * one-shot child of prepareProcess.ts, which is what calls this, because
 * pdf-lib must not be handed attacker-chosen bytes in the supervisor a warm
 * execution environment reuses across the chat sessions of different users. So
 * nothing here may assume that its process survives the answer.
 */
export const runChatSandboxPdfPage = async (
  request: ChatSandboxPdfPageRequest,
  deadlineEpochMs: number,
): Promise<ChatSandboxPdfPageResponse> =>
  extractPdfPage(request, createPresignedObjectTransfer(deadlineEpochMs, runObjectReadDirectly));
