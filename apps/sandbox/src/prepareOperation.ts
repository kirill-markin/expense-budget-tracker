/**
 * Text derivatives for one document or archive of one chat.
 *
 * A PDF, a DOCX, a workbook and a ZIP are all opaque to a shell: `grep` over
 * `/files/statement.pdf` finds nothing that is in it. So each convertible type
 * is converted once, at upload, into plain files stored beside the original -
 * `<path>.txt` for a document, `<path>.d/<name>` for a source with parts - and
 * everything downstream reads those with ordinary commands.
 *
 * What this operation does NOT do is read a page as an image: there is no OCR
 * here and none is wanted, so a scanned PDF yields a derivative holding its
 * page markers and no text, and says so.
 *
 * Every name in here is attacker-controlled - a filename the user uploaded, a
 * sheet name inside a workbook, an entry name inside an archive - so each one
 * is validated before it becomes a path and quoted before it becomes a message.
 *
 * Nothing here bounds what a parser costs, and that is deliberate: the only
 * bound on a parser that does not have to agree with it about what expands is
 * the conversion child's heap cap and wall clock in prepareProcess.ts. The
 * caps below bound what gets stored - the derivative set, its bytes, its names
 * - which the child cap says nothing about.
 */
import type { WorkSheet } from "xlsx";
import {
  describeUnmountableFileSet,
  describeUnsaveableFileBytes,
  describeUnsaveablePath,
  quoteUntrustedSandboxText,
  quoteUntrustedSandboxValue,
  SANDBOX_FILE_MAX_BYTES,
  SANDBOX_PREPARE_MAX_DERIVATIVES,
  SANDBOX_PREPARE_MAX_TEXT_CHARACTERS,
  SANDBOX_WORK_FILE_MEDIA_TYPE,
  type ChatSandboxFile,
  type ChatSandboxPrepareRequest,
  type ChatSandboxPrepareResponse,
  type ChatSandboxWriteSlot,
  type ChatSandboxWrittenFile,
} from "./contract.js";
import { loadConversionLibrary } from "./conversionLibrary.js";
import {
  classifyObjectReadFailure,
  hashObjectContent,
  requireDescribedObject,
  type ObjectReadFailure,
  type SandboxObjectTransfer,
} from "./objects.js";
import { isSandboxDefect } from "./sandboxDefect.js";

/** What this sandbox can turn into plain files, by what it produces. */
type SourceKind = "pdf" | "docx" | "workbook" | "zip";

/**
 * The media type the chat recorded for an upload, which is the signal the web
 * task validated it on.
 */
const SOURCE_KIND_BY_MEDIA_TYPE: ReadonlyMap<string, SourceKind> = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "workbook"],
  ["application/vnd.ms-excel", "workbook"],
  ["application/zip", "zip"],
  // The type Windows reports for an archive, accepted for `.zip` by
  // apps/web/src/lib/chatFiles.ts and therefore reachable here.
  ["application/x-zip-compressed", "zip"],
]);

/**
 * The second signal, consulted only when the media type names nothing at all.
 *
 * Browsers upload a workbook as `application/octet-stream` often enough that
 * keying on the media type alone would silently leave real spreadsheets
 * unconverted, which is why apps/web/src/lib/chatFiles.ts accepts that one type
 * for every extension it knows.
 */
const SOURCE_KIND_BY_EXTENSION: ReadonlyMap<string, SourceKind> = new Map([
  [".pdf", "pdf"],
  [".docx", "docx"],
  [".xlsx", "workbook"],
  [".xls", "workbook"],
  [".zip", "zip"],
]);

/**
 * The media types that name no format, which are the only ones whose extension
 * is consulted.
 *
 * A media type that names a format is believed even when it names one with no
 * derivative, and the asymmetry is the point: a PNG that the user called
 * `report.pdf` would otherwise be handed to pdf.js, which throws, and the
 * caller records that as a permanent derivatives_error for an ordinary mistake.
 * Saying it has no derivative is both true and recoverable. The one type listed
 * is CHAT_FILE_OPAQUE_MEDIA_TYPE in apps/web/src/lib/chatFiles.ts, which is the
 * only type an upload may carry that does not already name its format.
 */
const OPAQUE_MEDIA_TYPES: ReadonlySet<string> = new Set(["application/octet-stream"]);

/**
 * Extensions whose file already IS the plain text a derivative would hold,
 * whatever media type the browser reported for it.
 *
 * One entry and one reason: Windows with Excel installed reports a `.csv` as
 * `application/vnd.ms-excel`, which apps/web/src/lib/chatFiles.ts accepts for
 * that extension and which maps to `workbook` above - so a CSV would otherwise
 * be handed to SheetJS, spending a write slot on a `.d/Sheet1.csv` sidecar that
 * repeats the upload byte for byte. The extension decides here because it is
 * the half of the pair that is right.
 */
const SELF_DESCRIBING_EXTENSIONS: ReadonlySet<string> = new Set([".csv"]);

/** Suffix of the one text derivative a document produces. */
const TEXT_DERIVATIVE_SUFFIX = ".txt";

/**
 * Suffix of the directory holding the many derivatives of one source.
 *
 * A directory beside the original rather than a flat `<path>-<name>.csv`: the
 * parts of one source stay listable as a unit, and a name taken from inside the
 * source can never be mistaken for a sibling upload of the chat.
 */
const DERIVATIVE_DIRECTORY_SUFFIX = ".d";

/**
 * Ceiling on one archive entry, which is the ceiling on one stored file.
 *
 * Not a number of its own: a larger entry could not be stored whatever this
 * said, so stating it twice would only create two answers to one question.
 */
const ZIP_MAX_ENTRY_BYTES = SANDBOX_FILE_MAX_BYTES;

/**
 * Ceiling on everything one archive expands to.
 *
 * Bounded from below and from above by two different numbers. It cannot be
 * smaller than ZIP_MAX_ENTRY_BYTES, or that cap could never be reached, and
 * this is the next power of two above it. And /files may hold
 * SANDBOX_FILES_REQUEST_MAX_BYTES - 512 MiB - for a whole chat, so one archive
 * costs at most the 50 MiB a chat file may be plus this, which is 178 MiB of
 * that mount: two such archives fit and a third leaves a session whose next
 * command cannot be seeded at all. That third one is not this layer's to
 * refuse, because only the caller knows the session's running total, so this
 * number keeps the blast radius small rather than removing it.
 */
const ZIP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/**
 * Compressed bytes handed to the archive reader at a time.
 *
 * This is what makes the caps above bounds on memory rather than verdicts after
 * the fact. fflate inflates whatever it is pushed in one step and delivers the
 * result as a single chunk, so pushing a whole archive would expand a whole
 * entry before any cap saw a byte of it, and deflate's maximum ratio is 1032:1.
 * At 64 KiB in, no step can produce more than about 64 MiB however the stream
 * was crafted, so a cap that refuses stops the work instead of describing it.
 */
const ZIP_PUSH_CHUNK_BYTES = 64 * 1024;

/** One derivative, built whole in memory before anything is stored. */
type Derivative = Readonly<{ path: string; content: Uint8Array }>;

/** What a prepared source produced, and what is true about it besides. */
type PreparedDerivatives = Readonly<{
  derivatives: ReadonlyArray<Derivative>;
  notes: ReadonlyArray<string>;
}>;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * V8's whole message for a string built past the length one may hold.
 *
 * Exact rather than a substring: `Invalid typed array length: -1` shows that
 * these messages carry the offending value, so a test loose enough to be
 * convenient is loose enough to absorb an error that is not this one.
 */
const V8_STRING_LENGTH_EXCEEDED = "Invalid string length";

/**
 * The one RangeError a document can provoke, turned into a verdict on that
 * document.
 *
 * sandboxDefect.ts treats a RangeError as this repository's own bug, and for
 * every site but the two that use this one that is what it is. The exception is
 * a text piece built whole before anything counts it: `sheet_to_csv` returns a
 * whole sheet's CSV and mammoth a whole document's text, and past the
 * 536,870,888 characters a V8 string may hold the builder raises `RangeError:
 * Invalid string length` from inside the library.
 *
 * It is reachable, which is what this is for. Measured on Node 24.19 with a
 * .xlsx whose cells all point at one 32,000-character shared string: 40,977
 * bytes build 534,416,699 characters - 99.5% of the cap - and return, while
 * 41,456 bytes raise RangeError in 1.28 s at 628 MiB. So a 1% larger file
 * crosses it, well inside the 50 MB a chat file may be and inside both the
 * child's heap cap and its clock. Before this, such a file raised, which is a
 * Lambda FunctionError and an operator paged by a 41 KB upload.
 *
 * Caught here rather than bounded before the string exists, and that is a
 * choice against the other one. Predicting the length means predicting which
 * cells the serializer emits, how it renders numbers, dates and formulas, and
 * where it quotes and separates - a second implementation of the serializer's
 * own decisions, which is the thing the top of prepareProcess.ts is about and
 * which has to be right about all of it at once or it refuses real documents.
 * The RangeError is the opposite: it is the builder measuring itself, raised at
 * the one site that builds an unbounded string, so catching it there is exact
 * and carries no knowledge of either format.
 *
 * The text allowance is still what bounds the stored derivative - it refuses at
 * 32 M characters, an order of magnitude below this - and it simply never gets
 * to speak for a piece this large, because it is spent on the string after the
 * string exists.
 *
 * Which RangeError, by its message and not by its class, because the class is
 * several errors and only this one is the document's. Measured on Node 24.19:
 * `Maximum call stack size exceeded` is a RangeError, and both libraries walk
 * their documents recursively - a DOCX table nests arbitrarily - so a deep
 * enough package raises one inside the same expression; `Invalid typed array
 * length: -1` and `Array buffer allocation failed` are RangeErrors too. Matched
 * by class, each of them became this verdict: a permanent, model-visible
 * refusal of the user's file stating a reason that is not true of it, with
 * nothing anywhere saying the sandbox was the one at fault. Matched by message
 * they keep the answer sandboxDefect.ts gives every other RangeError in this
 * build - a fault of the build, raised - and they raise carrying their own
 * text, which is the only thing that can say whether a depth bound is worth
 * adding. The scope is already narrow enough for that to be safe: one library
 * expression per `try`, with none of this repository's own code inside either.
 */
const asSourceTextTooLarge = (subject: string, error: unknown): unknown =>
  error instanceof RangeError && error.message === V8_STRING_LENGTH_EXCEEDED
    ? new Error(
      `${subject} needs more extractable text than one JavaScript string can hold, so it cannot be converted: ${describeError(error)}`,
    )
    : error;

/**
 * How much of a retry an `unavailable` read is worth, said in the answer.
 *
 * `unavailable` promises that the same source read a minute earlier or later
 * would have been stored, and for a transfer that got no answer at all - a
 * dropped socket, a statusless failure, a spent budget - that is true and the
 * retry needs no bound: nothing about it says the object is not there.
 *
 * `denied` is every case where storage answered with a status, which
 * classifyObjectReadFailure does not subdivide and deliberately so: the body of
 * a 403 is the only thing separating an expired signature from a revoked
 * policy, and a 404 and a deleted object are the same answer. Two of those
 * never stop answering that way, so with no bound stated a caller following
 * this contract retries a `NoSuchKey` for as long as the row exists and the
 * file never reaches a terminal state.
 *
 * So the bound is stated where the caller reads it, and it is one attempt - the
 * same number bashOperation.ts's own `denied` advice gives the model, for the
 * same reason and over the same classification: a fresh tool call signs new
 * URLs, so exactly one more attempt separates an expired signature from an
 * object that is gone. A 5xx that outlived its three attempts is in here too,
 * and one more tool call is the right bound for it as well; the three surfaces
 * agreeing matters more than a fourth kind nothing else has.
 *
 * The statusless kinds get nothing appended, because an unbounded retry is the
 * right answer for them and a sentence saying so would be noise in every chat.
 */
const describeRetryBound = (failure: ObjectReadFailure): string =>
  failure === "denied"
    ? ". Object storage answered with a status rather than not answering, so this is worth exactly one more attempt with freshly signed URLs: an expired signature is fixed by that, and a deleted object or a revoked bucket policy answers the same way however many times it is asked"
    : "";

const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text);

const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
};

const classifySourceKind = (source: ChatSandboxFile): SourceKind | null => {
  const mediaType = source.mediaType.trim().toLowerCase();
  if (SELF_DESCRIBING_EXTENSIONS.has(extensionOf(source.path))) {
    return null;
  }

  return SOURCE_KIND_BY_MEDIA_TYPE.get(mediaType)
    ?? (OPAQUE_MEDIA_TYPES.has(mediaType)
      ? SOURCE_KIND_BY_EXTENSION.get(extensionOf(source.path)) ?? null
      : null);
};

/**
 * Characters no name taken from inside a source may carry into a path.
 *
 * The C0 controls and DEL cannot be stored in an object key at all, and a
 * backslash is not the character it looks like: an archive entry separates its
 * directories with a forward slash by specification, so a backslash in one is
 * either a literal character that reads as a separator to whoever opens the
 * derivative, or an attempt to be one. Either way the name is not what it
 * appears to be, so it is refused rather than rewritten.
 */
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001F\u007F\\]/;

/**
 * Why this archive entry cannot name a derivative, or null when it can.
 *
 * The traversal rules are the point: an entry name is chosen by whoever built
 * the archive, and `../../x` or `/etc/x` under a `.d/` directory would write a
 * derivative outside the source it belongs to. An interior slash is allowed,
 * because a nested entry is an ordinary archive, and every segment is then
 * checked on its own - which is also what refuses an empty segment, a leading
 * slash and a trailing one.
 */
const describeUnsafeEntryName = (name: string): string | null => {
  if (name === "") {
    return "it is empty";
  }
  if (UNSAFE_NAME_CHARACTERS.test(name)) {
    return "it carries a control character or a backslash";
  }
  if (name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "it is an absolute path or carries an empty or relative path segment";
  }

  return null;
};

/**
 * Why this sheet cannot name a derivative, or null when it can.
 *
 * An entry name's rules plus the one a sheet has of its own: a sheet is one
 * file, so a separator in its name would turn it into a directory. Excel
 * refuses to write such a name, which is exactly why a file carrying one is
 * worth refusing rather than trusting.
 */
const describeUnsafeSheetName = (name: string): string | null =>
  name.includes("/") ? "it carries a path separator" : describeUnsafeEntryName(name);

/**
 * Quoting and escaping a path or a name for a message, which lives in
 * contract.ts for the reason recorded there: one implementation of the escape
 * set, because a second copy would be the half that drifts.
 */
const quotedName = quoteUntrustedSandboxValue;

/**
 * Spend one source's text allowance, refusing the moment it runs out.
 *
 * A factory rather than a check on the finished text, because a source is
 * converted in pieces and the allowance is spent as they arrive: a page of a
 * PDF is spent text item by text item, and a workbook sheet by sheet, so a
 * second sheet is never built once the first exhausted the allowance. One
 * allowance per source rather than per derivative, because every derivative of
 * a source is held in memory at once.
 *
 * Within one piece it is a verdict and not a bound, and the piece is as large
 * as its parser makes it: `sheet_to_csv` returns a whole sheet's CSV and
 * mammoth a whole document's text before either is counted. Measured, a 40,977
 * byte .xlsx whose cells all point at one 32,000 character shared string builds
 * 534,416,699 characters at 1,132 MiB before this refuses them, and 479 bytes
 * more of the same shape do not reach this at all - they raise RangeError from
 * inside the serializer, which asSourceTextTooLarge is what answers. So this
 * does not bound what a conversion costs - the child's heap cap and its
 * resident ceiling do - and what it does bound is the stored derivative and the
 * text a later command reads.
 */
const createTextBudget = (): ((characters: number) => void) => {
  let spentCharacters = 0;

  return (characters: number): void => {
    spentCharacters += characters;
    if (spentCharacters > SANDBOX_PREPARE_MAX_TEXT_CHARACTERS) {
      throw new Error(
        `it holds at least ${String(spentCharacters)} characters of extractable text, past the ${String(SANDBOX_PREPARE_MAX_TEXT_CHARACTERS)} characters one source may be converted into`,
      );
    }
  };
};

/**
 * The handler pdf.js looks for on the global, or undefined if there is none.
 *
 * Read by `in` narrowing rather than a cast, because the global is declared
 * `unknown` in pdfjsWorker.d.ts: nothing about the worker build's shape is
 * promised, and the one property pdf.js consults is the only one worth
 * knowing.
 */
const workerMessageHandlerOf = (worker: unknown): unknown =>
  typeof worker === "object" && worker !== null && "WorkerMessageHandler" in worker
    ? worker.WorkerMessageHandler
    : undefined;

/**
 * Refuse a pdf.js whose worker is not resolved, here and not at getDocument.
 *
 * This is the one library whose load succeeding is not the same as the library
 * working. pdf.js resolves its worker lazily: the first `getDocument` awaits
 * `PDFWorker._setupFakeWorkerGlobal`, which reads
 * `globalThis.pdfjsWorker?.WorkerMessageHandler` and, finding nothing, falls
 * back to `await import(this.workerSrc)` - the runtime import no bundler can
 * follow. So a bundle that lost the assignment below fails every PDF of that
 * deployment inside phase 2's catch, where the answer is a permanent verdict on
 * the user's file; infra/aws/lib/chat-sandbox.ts names that very failure,
 * "Setting up fake worker failed", as what its bundle guard protects against.
 *
 * Checking the global instead of awaiting pdf.js's own getter is deliberate:
 * that getter memoises its promise for the life of the module, so a check
 * through it would answer whatever the first document in the process got, while
 * this reads the state pdf.js will read, every time, in any order.
 */
const requirePdfWorker = (worker: unknown): void => {
  if (workerMessageHandlerOf(worker) === undefined) {
    throw new Error(
      "globalThis.pdfjsWorker carries no WorkerMessageHandler, so pdf.js would resolve its worker through a runtime import that no bundle of this module can answer and fail every document with 'Setting up fake worker failed'",
    );
  }
};

/**
 * pdf.js, with its worker already inside this module's graph and resolved.
 *
 * Two things here are load-bearing, both measured on Node 24.19. The legacy
 * build is mandatory: the modern entry point throws `hashOriginal.toHex is not
 * a function` under this runtime. And `globalThis.pdfjsWorker` is what keeps it
 * loadable once bundled: under Node pdf.js disables the real worker and reaches
 * for `./pdf.worker.mjs` through a runtime `await import(this.workerSrc)`,
 * which no bundler can see, so an esbuild bundle of this module failed with
 * `Cannot find module '<bundle directory>/pdf.worker.mjs'`. Importing the
 * worker by a static specifier puts it in the graph and the global makes pdf.js
 * use it instead of that import, so one code path serves the installed layout
 * and the bundled one.
 *
 * The check after it is what makes this loader, and not the first document,
 * where a missing worker is answered - see requirePdfWorker.
 *
 * Imported here rather than at the top of the file so a `bash` invocation,
 * which is most of them, never parses the 4.6 MB of it.
 */
const loadPdfjs = async (): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> => {
  globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  requirePdfWorker(globalThis.pdfjsWorker);

  return import("pdfjs-dist/legacy/build/pdf.mjs");
};

/** The marker a text derivative puts in front of one page's text. */
const pdfPageMarker = (page: number): string => `--- page ${String(page)} ---`;

type PdfText = Readonly<{ text: string; hasText: boolean }>;

/** One text item of a page, as the text stream delivers it. */
type PdfTextItem = Readonly<{ str?: string; hasEOL?: boolean }>;

/** One delivery of a page's text stream, which is some of its items. */
type PdfTextChunk = Readonly<{ items: ReadonlyArray<PdfTextItem> }>;

/**
 * Every page's text, in page order, under its own marker.
 *
 * The markers are not decoration: they are how a model that found a figure in
 * the text knows which page number to ask for the image of, so they are written
 * even for a page that holds nothing. A document whose pages are all empty is
 * reported through `hasText` instead of as a failure - a scan is a PDF this
 * sandbox read correctly, not one it could not read.
 *
 * `streamTextContent` rather than `getTextContent`, and that is the whole
 * difference between a bound and a post-mortem: the second materialises every
 * item of a page before returning any of them, so a budget spent on the joined
 * result is spent after the memory is already held. The stream delivers a page
 * in pieces - 12,788 of them for a 50 MiB content stream, measured - so the
 * allowance is spent on each item as it arrives and a refusal stops the page
 * where it is.
 */
const extractPdfText = async (bytes: Uint8Array): Promise<PdfText> => {
  const pdfjs = await loadConversionLibrary("pdfjs-dist", loadPdfjs);
  // A copy, because the loading task takes the buffer it is given and detaches
  // it, and the caller still owns these bytes.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // No system fonts and no font-data URL: nothing here renders a glyph, and
    // both would have this function reach for files or hosts it cannot have.
    useSystemFonts: false,
    // Errors only, which silences the one warning pdf.js has about every
    // document here - that no `standardFontDataUrl` was given - and which is
    // about rendering, something nothing here does.
    //
    // It does not reach the three warnings pdf.js writes through `console.warn`,
    // and so to stderr: a missing `@napi-rs/canvas` and the `DOMMatrix` and
    // `Path2D` it cannot polyfill without it. Those go through this same
    // logger, but at the module scope of `pdf.mjs` while it is being imported,
    // before any option of this call exists, and the verbosity that bundle
    // reads is private to it. They appear only where that optional dependency
    // of pdfjs-dist is absent, which is the Lambda bundle and not a checkout,
    // and once per execution environment rather than once per document, since
    // the module is imported once. Silencing them would mean presetting those
    // two globals or replacing `console.warn`, so three lines of free text stay
    // beside this sandbox's structured records.
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const spendText = createTextBudget();
    const pages: Array<string> = [];
    let hasText = false;
    for (let page = 1; page <= document.numPages; page += 1) {
      const loaded = await document.getPage(page);
      try {
        const marker = `${pdfPageMarker(page)}\n`;
        spendText(marker.length + 1);
        const parts: Array<string> = [marker];
        const stream: ReadableStream<PdfTextChunk> = loaded.streamTextContent();
        const reader = stream.getReader();
        try {
          for (;;) {
            const delivery = await reader.read();
            if (delivery.done === true) {
              break;
            }
            for (const item of delivery.value.items) {
              // A marked-content item carries no text at all, and `hasEOL` is
              // where the line breaks are.
              if (item.str === undefined) {
                continue;
              }
              const text = item.hasEOL === true ? `${item.str}\n` : item.str;
              spendText(text.length);
              hasText = hasText || item.str.trim() !== "";
              parts.push(text);
            }
          }
        } catch (error) {
          // The stream is still running the page in the background, so it is
          // told to stop before the refusal leaves this function. pdf.js
          // requires the reason to be an error.
          await reader.cancel(error instanceof Error ? error : new Error(describeError(error)));
          throw error;
        }
        parts.push("\n");
        pages.push(parts.join(""));
      } finally {
        loaded.cleanup();
      }
    }

    return { text: pages.join("\n"), hasText };
  } finally {
    // The loading task, not the document: pdf.js 6 has no `document.destroy`.
    await task.destroy();
  }
};

const extractDocxText = async (bytes: Uint8Array): Promise<string> => {
  const mammoth = await loadConversionLibrary("mammoth", async () => (await import("mammoth")).default);
  const extracted = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    .catch((error: unknown) => {
      throw asSourceTextTooLarge("its text", error);
    });
  createTextBudget()(extracted.value.length);

  return extracted.value;
};

/**
 * One CSV per sheet, named after the sheet.
 *
 * The same reader serves `.xlsx` and the legacy BIFF8 `.xls`, which is why both
 * map to one kind: SheetJS tells them apart itself and this layer never has to -
 * and that is the whole of the container check here, deliberately. A great many
 * bank and ERP exports named `.xls` are an HTML `<table>`, a TSV, a SYLK or a
 * DIF file, all of which SheetJS reads and all of which apps/web/src/lib/
 * chatFiles.ts accepts under `application/vnd.ms-excel`, so requiring a ZIP or
 * a CFB container here refused real statements. What it costs to read one is
 * the child's to bound.
 */
const readWorkbookDerivatives = async (
  bytes: Uint8Array,
  sourcePath: string,
): Promise<ReadonlyArray<Derivative>> => {
  const { read, utils } = await loadConversionLibrary("xlsx", () => import("xlsx"));
  const workbook = read(bytes, { type: "array" });
  const spendText = createTextBudget();
  if (workbook.SheetNames.length > SANDBOX_PREPARE_MAX_DERIVATIVES) {
    throw new Error(
      `it holds ${String(workbook.SheetNames.length)} sheets, past the ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} derivatives one source may produce`,
    );
  }

  return workbook.SheetNames.map((name): Derivative => {
    const unsafeName = describeUnsafeSheetName(name);
    if (unsafeName !== null) {
      throw new Error(`its sheet ${quotedName(name)} cannot be stored as a file: ${unsafeName}`);
    }
    const sheet: WorkSheet | undefined = workbook.Sheets[name];
    if (sheet === undefined) {
      throw new Error(`it lists a sheet ${quotedName(name)} that it does not contain`);
    }

    let csv: string;
    try {
      csv = utils.sheet_to_csv(sheet);
    } catch (error) {
      throw asSourceTextTooLarge(`its sheet ${quotedName(name)}`, error);
    }
    spendText(csv.length);

    return {
      path: `${sourcePath}${DERIVATIVE_DIRECTORY_SUFFIX}/${name}.csv`,
      content: encodeText(csv),
    };
  });
};

/** One archive entry as a reader sees it, with whatever size it declares. */
type ZipEntryHeader = Readonly<{ name: string; declaredBytes: number | null }>;

/** Where one accepted entry's real bytes go, chunk by chunk. */
type ZipEntrySink = (chunk: Uint8Array, final: boolean) => void;

/**
 * Refuse an archive whose entry name is not one, directory marker aside.
 *
 * The trailing slash of a directory entry is stripped before the rules run,
 * because describeUnsafeEntryName refuses a trailing empty segment on its own
 * and a directory entry legitimately has one. The name is still checked rather
 * than skipped with the entry: nothing is written for a directory, so an entry
 * named `../../etc/` escapes nothing, but the archive meant it to, and an
 * unsafe name refuses the archive.
 */
const requireSafeEntryName = (name: string): void => {
  const unsafeName = describeUnsafeEntryName(name.endsWith("/") ? name.slice(0, -1) : name);
  if (unsafeName !== null) {
    throw new Error(`its entry ${quotedName(name)} cannot be stored as a file: ${unsafeName}`);
  }
};

/**
 * The refusals one pass over an archive's content entries can reach.
 *
 * A factory rather than a function, because three of the four are about the
 * entries seen so far. It is created once per pass and every archive gets two:
 * the central directory and the local file headers are two copies of the same
 * names and sizes, and an archive whose copies disagree has to be refused on
 * whichever of them is hostile.
 */
const createZipEntryGate = (): ((entry: ZipEntryHeader) => void) => {
  const seenNames = new Set<string>();
  let declaredTotalBytes = 0;

  return (entry: ZipEntryHeader): void => {
    // Two entries of one name would collapse into one derivative and lose the
    // other without any sign of it, so the archive is refused instead.
    if (seenNames.has(entry.name)) {
      throw new Error(`it holds the entry ${quotedName(entry.name)} twice`);
    }
    seenNames.add(entry.name);
    if (seenNames.size > SANDBOX_PREPARE_MAX_DERIVATIVES) {
      throw new Error(
        `it holds more than the ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} entries one source may produce derivatives for`,
      );
    }
    // An entry written with a data descriptor declares its size nowhere but
    // after its own data, which is not a refusal: the streamed bytes are
    // counted whatever a header said.
    if (entry.declaredBytes === null) {
      return;
    }
    if (entry.declaredBytes > ZIP_MAX_ENTRY_BYTES) {
      throw new Error(
        `its entry ${quotedName(entry.name)} expands to ${String(entry.declaredBytes)} bytes, past the ${String(ZIP_MAX_ENTRY_BYTES)} bytes one stored file may hold`,
      );
    }
    declaredTotalBytes += entry.declaredBytes;
    if (declaredTotalBytes > ZIP_MAX_TOTAL_BYTES) {
      throw new Error(
        `it expands to at least ${String(declaredTotalBytes)} bytes, past the ${String(ZIP_MAX_TOTAL_BYTES)} bytes one archive may expand to`,
      );
    }
  };
};

/**
 * Judge every entry of an archive on what it declares, decompressing nothing.
 *
 * `unzipSync` reads names and sizes from the central directory and takes the
 * declared size as each entry's output buffer length, so a filter that accepts
 * nothing walks that directory and allocates nothing at all. This is the cheap
 * half of the archive bound and the half that runs first: an archive that
 * announces a 4 GiB expansion is refused before a single inflate.
 *
 * The sizes are returned as well as judged, because the second pass counts what
 * each entry really holds and the two have to agree.
 */
const requireDeclaredZipShape = async (
  bytes: Uint8Array,
): Promise<ReadonlyMap<string, number>> => {
  const { unzipSync } = await loadConversionLibrary("fflate", () => import("fflate"));
  const gate = createZipEntryGate();
  const declaredBytesByName = new Map<string, number>();
  unzipSync(bytes, {
    filter: (entry) => {
      requireSafeEntryName(entry.name);
      if (!entry.name.endsWith("/")) {
        gate({ name: entry.name, declaredBytes: entry.originalSize });
        declaredBytesByName.set(entry.name, entry.originalSize);
      }

      return false;
    },
  });

  return declaredBytesByName;
};

/**
 * Hand every entry's real bytes to a sink the caller chooses per entry.
 *
 * fflate's `Unzip` reads each entry's name and size from its own local file
 * header and inflates the stream itself, where `unzipSync` takes both from the
 * central directory and trusts the declared size as the output length - so an
 * archive whose central directory understates an entry yields the truncated
 * bytes there and the real ones here. That is what turns the declared bound
 * above into a measured one, and declining an entry costs nothing: an unstarted
 * stream is never inflated.
 *
 * A sink stops the whole archive by throwing, and such a throw arrives at the
 * sink twice. fflate's synchronous inflate wraps the sink in its own try/catch
 * and re-delivers whatever it threw as an error of that same sink, so the
 * second throw is what carries it out of `push`. The same path delivers a
 * genuinely corrupt stream, which is why the sink is given the error at all.
 */
const streamZipEntries = async (
  bytes: Uint8Array,
  openEntry: (entry: ZipEntryHeader) => ZipEntrySink | null,
): Promise<void> => {
  const { Unzip, UnzipInflate } = await loadConversionLibrary("fflate", () => import("fflate"));
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file): void => {
    const sink = openEntry({ name: file.name, declaredBytes: file.originalSize ?? null });
    if (sink === null) {
      return;
    }
    file.ondata = (error, chunk, final): void => {
      if (error !== null) {
        throw error;
      }
      sink(chunk, final);
    };
    file.start();
  };
  for (let at = 0; at < bytes.length; at += ZIP_PUSH_CHUNK_BYTES) {
    const end = Math.min(at + ZIP_PUSH_CHUNK_BYTES, bytes.length);
    unzip.push(bytes.subarray(at, end), end === bytes.length);
  }
};

const concatenateChunks = (
  chunks: ReadonlyArray<Uint8Array>,
  totalBytes: number,
): Uint8Array => {
  const content = new Uint8Array(totalBytes);
  let at = 0;
  for (const chunk of chunks) {
    content.set(chunk, at);
    at += chunk.length;
  }

  return content;
};

/**
 * Refuse an archive whose two lists of entries are not the same list.
 *
 * The central directory is the list every archive tool shows - `unzip -l`,
 * Finder, Python's `zipfile` - and the local file headers are the list a
 * streaming reader walks. An entry in the second and not the first is stored in
 * the archive and invisible to everything the user could have checked it with,
 * so a derivative of it is a file the agent reads and the user never saw. An
 * entry in the first and not the second is the mirror image: a file the user
 * was shown and the agent has no derivative of.
 *
 * This is the stronger form of the size disagreement below, and it is the one
 * worth stating first: a wrong size means the user inspected a different
 * version of a file they did know about, while a missing record means they did
 * not know about the file at all. An EOCD declaring one record is enough to
 * hide the second entirely, costs nothing to craft, and is why this is checked
 * on the sets rather than only where the two lists overlap.
 */
const requireOneSetOfEntries = (
  declaredNames: ReadonlySet<string>,
  storedNames: ReadonlySet<string>,
): void => {
  const undeclared = [...storedNames].find((name) => !declaredNames.has(name));
  if (undeclared !== undefined) {
    throw new Error(
      `it stores the entry ${quotedName(undeclared)} that its central directory does not list, so an archive tool would not show it at all`,
    );
  }
  const unstored = [...declaredNames].find((name) => !storedNames.has(name));
  if (unstored !== undefined) {
    throw new Error(
      `its central directory lists the entry ${quotedName(unstored)} that the archive does not store, so an archive tool would show a file this chat has no derivative of`,
    );
  }
};

/**
 * One derivative per archive entry, under the entry's own name.
 *
 * Four caps, each for its own failure: the entry count, because every entry
 * becomes a file of the chat and a slot the caller had to mint; one entry's
 * size, because a larger one could not be stored; the total, because an archive
 * is the one upload whose expanded size is unrelated to the bytes that were
 * checked when it arrived; and a duplicate name, because two of them collapse
 * into one derivative. All four are judged twice, on what the archive declares
 * before anything is decompressed and then on the bytes that actually arrive,
 * because a declared size is a claim and the stored derivative must be the real
 * content of the entry rather than a buffer cut to the length it announced.
 *
 * Refused rather than truncated at the cap: a derivative set missing the
 * entries that did not fit would be indistinguishable from a complete one,
 * which is the shape that turns a partial read into a confident wrong answer.
 *
 * And refused, too, when the two copies disagree about which entries exist or
 * about how large one is. Nothing here needs the declaration any more - the
 * stored derivative is what arrived - but an archive whose central directory
 * does not match its contents is not harmless: that directory is what every
 * archive tool lists, so a user who checked the archive before sending it would
 * have inspected a different set of files, or a different file, from the one the
 * agent reads. In a chat about financial statements that is worth refusing
 * rather than silently resolving in our own favour.
 */
const readZipDerivatives = async (
  bytes: Uint8Array,
  sourcePath: string,
): Promise<ReadonlyArray<Derivative>> => {
  const declaredBytesByName = await requireDeclaredZipShape(bytes);
  const derivatives: Array<Derivative> = [];
  const storedNames = new Set<string>();
  const gate = createZipEntryGate();
  let totalBytes = 0;
  await streamZipEntries(bytes, (entry) => {
    requireSafeEntryName(entry.name);
    // A directory entry carries no content, so it has no derivative; the
    // directories of the set come from the nested names themselves.
    if (entry.name.endsWith("/")) {
      return null;
    }
    gate(entry);
    storedNames.add(entry.name);
    const chunks: Array<Uint8Array> = [];
    let entryBytes = 0;

    return (chunk, final): void => {
      entryBytes += chunk.length;
      if (entryBytes > ZIP_MAX_ENTRY_BYTES) {
        throw new Error(
          `its entry ${quotedName(entry.name)} expands to at least ${String(entryBytes)} bytes, past the ${String(ZIP_MAX_ENTRY_BYTES)} bytes one stored file may hold`,
        );
      }
      totalBytes += chunk.length;
      if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
        throw new Error(
          `it expands to at least ${String(totalBytes)} bytes, past the ${String(ZIP_MAX_TOTAL_BYTES)} bytes one archive may expand to`,
        );
      }
      chunks.push(chunk);
      if (final) {
        const declaredBytes = declaredBytesByName.get(entry.name);
        if (declaredBytes !== undefined && declaredBytes !== entryBytes) {
          throw new Error(
            `its entry ${quotedName(entry.name)} holds ${String(entryBytes)} bytes and its central directory declares ${String(declaredBytes)}, so what it stores is not what an archive tool would show for it`,
          );
        }
        derivatives.push({
          path: `${sourcePath}${DERIVATIVE_DIRECTORY_SUFFIX}/${entry.name}`,
          content: concatenateChunks(chunks, entryBytes),
        });
      }
    };
  });
  requireOneSetOfEntries(new Set(declaredBytesByName.keys()), storedNames);

  return derivatives;
};

/**
 * Why this source has no text derivative, for the model that will read it.
 *
 * Two reasons rather than one, because the type is the wrong thing to name for
 * a self-describing extension: a CSV is a format this chat does convert when it
 * arrives as a sheet of a workbook, and saying otherwise would read as a defect
 * rather than as the one true thing, which is that the file is already text.
 */
const describeMissingDerivative = (source: ChatSandboxFile): string =>
  SELF_DESCRIBING_EXTENSIONS.has(extensionOf(source.path))
    ? `${quotedName(source.path)} is already the plain text a derivative would hold, so it has none: read the file itself.`
    : `${quotedName(source.path)} has no text derivative: ${quoteUntrustedSandboxText(source.mediaType)} is not a format this chat converts, so read the file itself.`;

const buildDerivatives = async (
  kind: SourceKind,
  source: ChatSandboxFile,
  bytes: Uint8Array,
): Promise<PreparedDerivatives> => {
  const textPath = `${source.path}${TEXT_DERIVATIVE_SUFFIX}`;
  switch (kind) {
    case "pdf": {
      const extracted = await extractPdfText(bytes);

      return {
        derivatives: [{ path: textPath, content: encodeText(extracted.text) }],
        notes: extracted.hasText
          ? []
          : [`${quotedName(source.path)} has no text layer, so ${quotedName(textPath)} holds its page markers and no text: its pages carry text only as pixels and have to be read as images.`],
      };
    }
    case "docx": {
      const text = await extractDocxText(bytes);

      return {
        derivatives: [{ path: textPath, content: encodeText(text) }],
        notes: text.trim() === ""
          ? [`${quotedName(source.path)} carries no extractable text, so ${quotedName(textPath)} is empty: whatever it shows is images rather than text.`]
          : [],
      };
    }
    case "workbook":
      return { derivatives: await readWorkbookDerivatives(bytes, source.path), notes: [] };
    case "zip":
      return { derivatives: await readZipDerivatives(bytes, source.path), notes: [] };
  }
};

/**
 * Refuse a derivative set this chat could not hold, before any of it is stored.
 *
 * Both halves matter and both come from the contract rather than from here. A
 * path past what a chat may store is a file the next command could never seed,
 * which is the shape that leaves a chat where nothing runs; and a set where one
 * derivative is another's parent directory, or where two share a path, is one
 * the mounts cannot represent - reachable from a sheet named like a sibling
 * entry, so it is checked rather than assumed.
 */
const requireStorableDerivatives = (
  derivatives: ReadonlyArray<Derivative>,
  source: ChatSandboxFile,
): void => {
  for (const derivative of derivatives) {
    const unsaveablePath = describeUnsaveablePath(derivative.path);
    if (unsaveablePath !== null) {
      throw new Error(
        `${quotedName(derivative.path)} cannot be stored beside ${quotedName(source.path)}: ${unsaveablePath}`,
      );
    }
    const unsaveableBytes = describeUnsaveableFileBytes(derivative.content.byteLength);
    if (unsaveableBytes !== null) {
      throw new Error(`${quotedName(derivative.path)} cannot be stored: ${unsaveableBytes}`);
    }
  }
  const unmountableSet = describeUnmountableFileSet(derivatives.map((entry) => entry.path));
  if (unmountableSet !== null) {
    throw new Error(`its derivatives cannot be stored together: ${unmountableSet}`);
  }
};

/**
 * Raise when the request carries fewer slots than the source has parts.
 *
 * Its own class, so the answer rests on the error's type and not on its text:
 * the upload below is answered `unavailable` and this is raised, and those two
 * leave the same `catch`.
 *
 * A raise and not an answer, which is the correction this check needed: how
 * many parts a source has is a property of the source, but how many slots are
 * signed for it is a property of the request, and the schema admits 1 to
 * SANDBOX_PREPARE_MAX_DERIVATIVES of them. So a caller that minted 8 would have
 * had a 30-sheet workbook answered `status: "failed"` and written down as
 * permanently unconvertible - a verdict on a file that is fine, for a mistake
 * made entirely on the other side of the wire. It is the concurrency guard's
 * kind of failure, not a document's: someone wired it wrong, and that is worth
 * an operator's attention rather than a note in a chat.
 *
 * Checked against the whole set and before the first upload, so nothing is
 * stored for a source this request could not have held. Nothing reachable
 * raises it: the contract states the bound both sides read, and a caller that
 * mints that many slots can never be short of them.
 */
class PrepareRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PrepareRequestError";
  }
}

const requireWriteSlots = (
  derivatives: ReadonlyArray<Derivative>,
  writeSlots: ReadonlyArray<ChatSandboxWriteSlot>,
): void => {
  if (derivatives.length > writeSlots.length) {
    throw new PrepareRequestError(
      `Chat sandbox prepare request carries ${String(writeSlots.length)} write slots and this source needs ${String(derivatives.length)}: the caller must mint ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} of them, which is the number of derivatives one source may produce`,
    );
  }
};

/**
 * Spend one slot per derivative, in the order the source produced them.
 *
 * `writeSlots[index]` is a slot and never undefined because requireWriteSlots
 * runs on the line above, which is where that check belongs: nothing else in
 * this function establishes the invariant its indexing rests on, and it used to
 * be established two phases away, in a caller whose other checks were all about
 * the source. The list is a parameter rather than read from the request inside
 * here, so the one that was counted is the one that is spent.
 */
const storeDerivatives = async (
  derivatives: ReadonlyArray<Derivative>,
  writeSlots: ReadonlyArray<ChatSandboxWriteSlot>,
  transfer: SandboxObjectTransfer,
): Promise<ReadonlyArray<ChatSandboxWrittenFile>> => {
  requireWriteSlots(derivatives, writeSlots);
  const stored: Array<ChatSandboxWrittenFile> = [];
  for (const [index, derivative] of derivatives.entries()) {
    const slot = writeSlots[index];
    await transfer.writeObject(slot.putUrl, SANDBOX_WORK_FILE_MEDIA_TYPE, derivative.content);
    stored.push({
      path: derivative.path,
      slotId: slot.slotId,
      sizeBytes: derivative.content.byteLength,
      sha256: hashObjectContent(derivative.content),
    });
  }

  return stored;
};

/**
 * Convert one source, or say why it produced nothing.
 *
 * This is the whole of what the conversion child runs, and the transfer is a
 * port the way diffWorkFiles's is, so the conversions are driven without a
 * network and without a fork.
 *
 * Everything is built and validated before the first upload, and any failure
 * leaves the answer with no derivatives field at all: a caller cannot record
 * half an archive as a whole one. The failure text quotes the source path and
 * then the reason as one untrusted string, because every reason here was built
 * by interpolating a name that came out of the source.
 *
 * And it answers only what is true of the source. Three outcomes, because the
 * caller does three different things with them and the error text is not
 * something it may parse to decide which.
 *
 * A `status: "failed"` response says "this file could not be prepared", which
 * the caller records as a permanent derivatives_error it never retries: the
 * right answer for a corrupt or encrypted container, a package this layer
 * refuses to store, an archive past a cap, a sheet whose text will not fit in
 * one JavaScript string, and bytes that are not the object the row describes. A
 * `status: "unavailable"` response says the same file would have been prepared
 * had object storage answered - a refused or unreachable pre-signed URL, a
 * transfer budget spent, an upload that failed after everything was built, a
 * conversion child the kernel chose for some other process's memory - so it is
 * retryable and must not be written down. Before it existed those arrived as
 * the same `failed`, which marked whatever was uploaded during an outage
 * unconvertible for good.
 *
 * Retryable is not unbounded, and the answer says which it is. A refused read
 * is worth one more attempt and no more, because storage answering "refused"
 * is what a deleted object and a revoked bucket policy answer forever;
 * describeRetryBound puts that sentence in the reason, so a caller following
 * this contract reaches a terminal state instead of looping.
 *
 * And what is true of neither is raised: a library this build cannot load, this
 * repository's own TypeError, a request carrying fewer slots than the source
 * has parts. The caller sees a failed invocation, which is not a thing a chat
 * can show and is not meant to be - each of the three is a fault an operator
 * has to fix, none is fixed by retrying, and a Lambda FunctionError is the only
 * channel that tells anybody. That is what makes `unavailable` worth having:
 * with the retryable failures answered, everything still arriving as a raised
 * error is worth paging on, and the alarm in infra/aws/lib/monitoring.ts can
 * stay at one error in fifteen minutes. Which is also why the predicate
 * deciding it is sandboxDefect.ts's and not a list of error classes written
 * here: a TypeError is what a dropped socket arrives as, and raising those put
 * the commonest transient failure of this operation on that alarm.
 *
 * The phases below therefore divide the work rather than the classification:
 * every catch asks the same two questions, in the same order, because a bug of
 * this workspace is this workspace's fault wherever it is raised, and a verdict
 * is a verdict only if nothing else explains it.
 */
export const prepareSource = async (
  request: ChatSandboxPrepareRequest,
  transfer: SandboxObjectTransfer,
): Promise<ChatSandboxPrepareResponse> => {
  const startedAt = Date.now();
  const refused = (reason: string): ChatSandboxPrepareResponse => ({
    status: "failed",
    error: `${quotedName(request.source.path)} could not be prepared: ${quoteUntrustedSandboxText(reason)}`,
    durationMs: Date.now() - startedAt,
  });
  const unavailable = (reason: string): ChatSandboxPrepareResponse => ({
    status: "unavailable",
    // "could not be prepared now", against the other arm's "could not be
    // prepared": both end up in a model-visible prompt if the caller renders
    // them, and the one word is the difference between a file to give up on and
    // a file to come back to.
    error: `${quotedName(request.source.path)} could not be prepared now: ${quoteUntrustedSandboxText(reason)}`,
    durationMs: Date.now() - startedAt,
  });
  const kind = classifySourceKind(request.source);
  if (kind === null) {
    return {
      status: "prepared",
      derivatives: [],
      notes: [describeMissingDerivative(request.source)],
      durationMs: Date.now() - startedAt,
    };
  }

  let bytes: Uint8Array;
  try {
    // Verified against the row the request came from, exactly as a /files read
    // is: a derivative taken from bytes the chat was told it is not reading
    // would be wrong content stored under a trusted name.
    bytes = requireDescribedObject(
      request.source.path,
      await transfer.readObject(request.source.getUrl),
      request.source,
    );
  } catch (error) {
    // A bug of this workspace's own first, because it is what
    // classifyObjectReadFailure calls `unknown`: an unknown read failure is
    // retryable and a bug here is not, so the order of these two decides it.
    // The predicate is the shared one deliberately, and this is the read where
    // its transport exemption earns its keep: every way a pre-signed transfer
    // fails below the status line is a TypeError, so a bare class test raised
    // the commonest transient failure this operation has instead of answering
    // it, and the arm below was dead for all four of them.
    if (isSandboxDefect(error)) {
      throw error;
    }
    // Then the same classification bashOperation.ts and presignedFs.ts give a
    // /files read, so one place decides what a read failure is. Two of its
    // kinds are facts about this object - its bytes are not the ones the row
    // describes, and no retry of anything will make them so - and the rest are
    // storage: refused, unreachable after three attempts, or a transfer budget
    // the invocation had already spent, which the next invocation has again.
    const failure = classifyObjectReadFailure(error);

    return failure === "size_mismatch" || failure === "digest_mismatch"
      ? refused(describeError(error))
      : unavailable(`${describeError(error)}${describeRetryBound(failure)}`);
  }

  let prepared: PreparedDerivatives;
  try {
    prepared = await buildDerivatives(kind, request.source, bytes);
    requireStorableDerivatives(prepared.derivatives, request.source);
  } catch (error) {
    // The phase where the source's own bytes are parsed, so a failure is the
    // document: a corrupt container, an encrypted one, a part past a cap, a
    // name that cannot be stored.
    //
    // Everything except our own faults, which is the same question the read
    // phase asks and deliberately so. Most of the code reached from here is
    // this repository's rather than a parser's - the archive walk, the caps,
    // the name rules, the budget - so answering "whatever it was, blame the
    // file" would record this workspace's bugs against the user's uploads,
    // where the read phase, which is almost all library code, raises them.
    if (isSandboxDefect(error)) {
      throw error;
    }

    return refused(describeError(error));
  }

  // A third phase and a third catch, because a derivative that was built and
  // accepted and then could not be uploaded is object storage failing: it is
  // neither of the things the phase above answers, and recording a 503 as a
  // permanent verdict on the user's file is what sharing a catch with it did.
  // `unavailable` rather than a raise, because this is the most retryable
  // failure the operation has - the derivatives are already known to be
  // storable, so the next attempt has only the transfer left to fail. The one
  // thing here that is not storage is a slot list too short for them, which is
  // the caller's own mistake and raises.
  try {
    return {
      status: "prepared",
      derivatives: await storeDerivatives(prepared.derivatives, request.writeSlots, transfer),
      notes: prepared.notes,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (isSandboxDefect(error) || error instanceof PrepareRequestError) {
      throw error;
    }

    return unavailable(describeError(error));
  }
};

