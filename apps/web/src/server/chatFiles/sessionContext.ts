/**
 * What this chat session's files contribute to one turn's prompt: a listing of
 * them, the bytes of its resident images, and the bytes of the `view_file`
 * results the stored history replays.
 *
 * The listing exists because nothing else tells the model what it holds. A
 * document is converted in a turn's prologue, at most
 * CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN of them per turn - so on the turn it
 * arrived on within that bound, and a later turn beyond it - and read as text
 * beside the original; a conversion that cannot happen writes a permanent reason
 * into the row - which, without this, no surface ever read: the model would
 * `cat` a PDF and reason about its binary, and the user would never be told the
 * file could not be converted. So both are rendered here, each in the clause of
 * the file it is about.
 *
 * Every part of it is paid on every turn, which is what bounds their shape. The
 * listing is capped and says when it was cut, and it is omitted entirely for a
 * session with no files, so an ordinary chat pays nothing for it. The view
 * results cost one read each, so only the newest
 * CHAT_FILE_VIEW_REPLAYS_PER_TURN distinct files and pages are read for at all -
 * a read that fails spends one of those - and the rest keep their text and say
 * so. The images are the same shape of cost under
 * CHAT_RESIDENT_IMAGES_PER_TURN, and an image past it is named by the listing
 * and shown by `view_file` rather than carried.
 */
import { PDF_MEDIA_TYPE } from "@/lib/chatPdf";
import {
  CHAT_ATTACHMENT_MAXIMUM_BYTES,
  isSendableChatImage,
} from "@/server/chat/attachments/validation";
import { readChatSandboxFunctionName } from "@/server/chat/sandbox/invoke";
import type { ContentPart, ImageContentPart } from "@/server/chat/types";
import {
  CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN,
  mentionsExpiredChatFileObject,
} from "@/server/chatFiles/derivatives";
import {
  buildChatFileObjectKey,
  readChatFileObjectBytesIfConfigured,
} from "@/server/chatFiles/objectStore";
import {
  listSessionChatFiles,
  type ChatFile,
} from "@/server/chatFiles/store";
import {
  viewChatFile,
  type ChatFileViewContext,
  type ChatFileViewResult,
} from "@/server/chatFiles/viewFile";
import type {
  ChatFileViewPart,
  ChatFileViewPartsByCallId,
  ServerChatMessage,
  StoredChatFileViewCall,
} from "@/server/chat/openai/responses/replayItems";
import { log } from "@/server/logger";
import {
  classifyChatSandboxSourceKind,
  quoteUntrustedSandboxValue,
  SANDBOX_FILES_DIR,
  SANDBOX_WORK_DIR,
} from "../../../../sandbox/src/contract";

/**
 * Characters of listing one turn may spend.
 *
 * Every turn of a session with files pays this, so it is a standing cost rather
 * than a one-off: an ordinary session of three uploads renders in about 200
 * characters, and this leaves room for a conversion reason, which is a sentence
 * rather than a word. Past it the listing is cut and says how many files it did
 * not name, because a listing that silently stops is one the model reads as the
 * whole set.
 *
 * It bounds the header and the named lines. The line that says how many files
 * were left out is added past it, so a cut listing renders longer than this by
 * that line - 85 characters, and 84 to 87 across the digit counts of the number
 * it carries. The cap test drives 60 files: it names 40 of them for 1,188
 * bounded characters and renders 1,274 in all. Those same 40 on their own are
 * not cut, because 1,183 is under the cap - what the test exercises is the 60.
 * A ceiling on what the listing chooses to name, rather than on the string.
 */
export const CHAT_FILE_MANIFEST_MAX_CHARS = 1_200;

/**
 * Files one turn may rebuild the bytes of, newest first.
 *
 * A ceiling that does not grow with what the session has looked at, for the
 * reason CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN has one: this runs in front of
 * the turn's first token, and each rebuild is an object read or a sandbox
 * invocation. Without it, a session that looked at twenty pages pays twenty
 * reads before every later message, for good.
 *
 * Counted on attempts and not on answers, so a read that failed is charged like
 * one that answered. The cost this bounds is the read, which a reference pays
 * whether or not it gets a part back - and the failing reads are the expensive
 * ones, a timeout or a retry chain each. Charging only the answers would leave
 * the happy path held to four cheap reads and the storage or sandbox fault
 * unbounded, every stored view attempting its own slow read in front of every
 * turn's first token: the wrong way round.
 *
 * Four, because each rebuilt part is also 1,600 to 4,000 tokens of the turn's
 * input, so four is already up to 16,000 of the 120,000 token budget. An older
 * result keeps its text and says the bytes are not in this request, which the
 * model answers by calling view_file again for the one it still needs. A result
 * this turn could not rebuild says exactly the same thing, so the model cannot
 * tell a reference the bound was spent before from one whose read failed -
 * deliberately, because the move it should make is the same, and a fresh
 * view_file call that fails too answers with the tool's own error rather than
 * with this note.
 *
 * This is a bound on one turn's reads and not a residency policy: which results
 * stay in a session's history, and the eviction that enforces it, are the
 * history rewrite's.
 */
export const CHAT_FILE_VIEW_REPLAYS_PER_TURN = 4;

/**
 * Images one turn carries the bytes of, newest first.
 *
 * An image of a message is a file of the session like any other attachment, so
 * its bytes are read from the object and rendered into the input again on every
 * turn. That is one object read per resident image per turn, which is the cost
 * this bounds, and eight of them is the same ceiling
 * CHAT_FILE_VIEW_REPLAYS_PER_TURN already allows: an image is charged at
 * `IMAGE_TOKENS`, so eight is 16,000 tokens of the 120,000 token budget, where
 * four view results are up to 16,000 too.
 *
 * A count rather than a rolling per-turn eviction, which is the decision that
 * keeps the prompt cache: the cache matches on a byte-identical rendered prefix,
 * and rewriting which images a turn carries on every turn would break it for the
 * whole prompt behind the first rewritten message. A count only ever grows, so
 * an image leaves the resident set once and stays out, and a session of eight
 * images or fewer - which is nearly all of them - never changes a rendered byte.
 * The one event that moves an image back in is the user attaching bytes the
 * session already holds, which resolves to that same row: it costs the prompt
 * behind the two messages whose images swapped, and is paid so that the image
 * the turn is about is the one sent.
 *
 * An image past it does not vanish: the manifest names its path and its size on
 * every turn, and `view_file` shows that path, so the model can still see that
 * the image exists and ask for it. What it costs is the model noticing it has to
 * ask.
 */
export const CHAT_RESIDENT_IMAGES_PER_TURN = 8;

export type ChatFileManifestDependencies = Readonly<{
  listSessionChatFiles: typeof listSessionChatFiles;
  viewChatFile: typeof viewChatFile;
  readObjectBytes: typeof readChatFileObjectBytesIfConfigured;
  /**
   * The sandbox function, or null where none is configured. Read here as well as
   * by the derivatives pass, because the listing states what another message
   * will do and that pass is what would do it.
   */
  readFunctionName: typeof readChatSandboxFunctionName;
  log: typeof log;
}>;

/**
 * What this turn can do with one image of the session.
 *
 * The three states that carry no bytes are told apart because they are three
 * different instructions to the model: a capped image's object is still there,
 * so `view_file` shows it on the turn the model asks; an unavailable one's is
 * not, so that same call is bound to fail and what is left is asking the user to
 * attach it again; and a row past the bytes one image may be shown as is refused
 * by `view_file` and by the wire alike, so neither of those answers it and only
 * a smaller copy would. Production expires a stored object at
 * CHAT_FILES_EXPIRATION_DAYS while the payload keeps its reference for good, so
 * every image of an old enough session reads as unavailable on every turn, and
 * collapsing the states would spend a tool call, or a re-attach that cannot
 * succeed, on each of them every time.
 */
export type ChatImageSendState =
  | Readonly<{ kind: "resident"; base64Data: string }>
  | Readonly<{ kind: "capped" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "oversized" }>;

export type ChatTurnFileContext = Readonly<{
  /** The trailing system item, or null when this session holds no file. */
  manifest: string | null;
  viewParts: ChatFileViewPartsByCallId;
  /**
   * How each image of the messages this input may send is to be sent, by the
   * file id of the part that stands for it. Absent is the turn that read no
   * object at all, which the input renders as capped.
   */
  imageStateByFileId: ReadonlyMap<string, ChatImageSendState>;
}>;

export const EMPTY_CHAT_TURN_FILE_CONTEXT: ChatTurnFileContext = {
  manifest: null,
  viewParts: new Map(),
  imageStateByFileId: new Map(),
};

const MANIFEST_HEADER =
  `Files of this chat, as "path" bytes, then what else exists for that file:`;

const sortedByPath = (files: ReadonlyArray<ChatFile>): ReadonlyArray<ChatFile> =>
  [...files].sort((left, right) => left.path.localeCompare(right.path));

/**
 * The directory an archive's or a workbook's parts share, or null when the set
 * is one file.
 *
 * Named rather than listed because the parts of one source are what the cap is
 * spent on fastest: a 64-entry archive is 64 paths the model can see with one
 * `ls` and does not need in every prompt.
 */
const commonParentDirectory = (
  paths: ReadonlyArray<string>,
): string | null => {
  const directories = new Set(paths.map((path) => path.slice(0, path.lastIndexOf("/") + 1)));
  const directory = directories.size === 1 ? [...directories][0] : undefined;

  return directory === undefined ? null : directory;
};

const describeDerivatives = (
  derivatives: ReadonlyArray<ChatFile>,
): string => {
  const paths = sortedByPath(derivatives).map((derivative) => derivative.path);
  const first = paths[0];
  if (first === undefined) {
    return "";
  }
  if (paths.length === 1) {
    return ` -> ${quoteUntrustedSandboxValue(first)}`;
  }
  const directory = commonParentDirectory(paths);

  return directory === null
    ? ` -> ${String(paths.length)} files, see ls ${SANDBOX_FILES_DIR}`
    : ` -> ${String(paths.length)} files under ${quoteUntrustedSandboxValue(directory)}`;
};

/**
 * What is still true of a PDF with no text copy.
 *
 * The remedy that holds in nearly every one of those states, and the only one
 * this function can know: a conversion that failed on the file's own bytes or on
 * its path says nothing about whether the sandbox can copy out a page, which is
 * a different operation on the same file. A fact about the media type rather
 * than about the cause, so it is additive - the reason beside it carries its own
 * remedy, and that wording is the derivative pass's to get right.
 *
 * The exception is the one verdict that is about the stored object instead:
 * `view_file` presigns that very object to copy a page out of it, so offering a
 * page for an upload whose copy has expired would spend a sandbox invocation on
 * a read that cannot answer, and let the model tell the user the file is still
 * viewable rather than ask for it again.
 */
const describeViewFileRemedy = (file: ChatFile): string =>
  file.mediaType === PDF_MEDIA_TYPE && !mentionsExpiredChatFileObject(file.derivativesError)
    ? ", and view_file still shows one page of it at a time"
    : "";

/**
 * What one upload has beside itself, as one clause.
 *
 * The four states are what the row can be in, and each is a different thing for
 * the model to do: a converted file has a text copy to read, an unconvertible
 * one has a reason that says why and what to do instead, a file still waiting is
 * worth asking about again, and a file no conversion applies to - an image, a
 * CSV - has nothing to say at all. The permanent reason is written by the
 * derivative pass for exactly this clause, so it is rendered whole rather than
 * summarized.
 *
 * `conversionsAvailable` is false where this deployment has no sandbox to
 * convert with. Then the third state never ends, because the pass that would end
 * it returns before it reads a row, so the clause that says another message will
 * produce a text copy is suppressed rather than repeated on every turn of the
 * session for its whole life.
 */
const describeAttachment = (
  file: ChatFile,
  derivatives: ReadonlyArray<ChatFile>,
  conversionsAvailable: boolean,
): string => {
  const line = `${quoteUntrustedSandboxValue(file.path)} ${String(file.sizeBytes)}`;
  if (file.derivativesError !== null) {
    return `${line} -> no text copy: ${file.derivativesError}${describeViewFileRemedy(file)}`;
  }
  if (derivatives.length > 0) {
    return `${line}${describeDerivatives(derivatives)}`;
  }
  if (
    conversionsAvailable
    && file.derivativesPreparedAt === null
    && classifyChatSandboxSourceKind(file.mediaType, file.path) !== null
  ) {
    return `${line} -> text copy not made yet, ${String(CHAT_FILE_DERIVATIVE_SOURCES_PER_TURN)} files are converted per message, so send another message to have it made`;
  }

  return line;
};

/**
 * Lines inside the cap, plus the count they left out.
 *
 * Attachments come first and `work` files last, so what is cut is the model's
 * own scratch output rather than the user's uploads.
 */
const fitManifestLines = (
  lines: ReadonlyArray<string>,
): Readonly<{ kept: ReadonlyArray<string>; omitted: number }> => {
  const kept: Array<string> = [];
  let characters = MANIFEST_HEADER.length;
  for (const line of lines) {
    if (characters + line.length + 1 > CHAT_FILE_MANIFEST_MAX_CHARS) {
      break;
    }
    characters += line.length + 1;
    kept.push(line);
  }

  return { kept, omitted: lines.length - kept.length };
};

/**
 * This session's files as the model sees them, or null when it holds none.
 *
 * Unconfirmed rows are left out: an upload still in flight has no object to read
 * and is not mounted, so naming it would describe a file no command of this chat
 * can open.
 *
 * `conversionsAvailable` is the one thing about this deployment the rows cannot
 * carry, so it is a parameter: this stays a pure function of what it is given.
 */
export const buildChatFileManifest = (
  files: ReadonlyArray<ChatFile>,
  conversionsAvailable: boolean,
): string | null => {
  const confirmed = files.filter((file) => file.isConfirmed);
  const derivativesBySourceId = new Map<string, Array<ChatFile>>();
  for (const file of confirmed) {
    if (file.origin !== "derived" || file.sourceFileId === null) {
      continue;
    }
    const existing = derivativesBySourceId.get(file.sourceFileId);
    if (existing === undefined) {
      derivativesBySourceId.set(file.sourceFileId, [file]);
      continue;
    }
    existing.push(file);
  }

  const lines = [
    ...sortedByPath(confirmed.filter((file) => file.origin === "attachment")).map(
      (file) => describeAttachment(
        file,
        derivativesBySourceId.get(file.fileId) ?? [],
        conversionsAvailable,
      ),
    ),
    ...sortedByPath(confirmed.filter((file) => file.origin === "work")).map(
      (file) => `${quoteUntrustedSandboxValue(file.path)} ${String(file.sizeBytes)}`,
    ),
  ];
  if (lines.length === 0) {
    return null;
  }

  const { kept, omitted } = fitManifestLines(lines);

  return [
    MANIFEST_HEADER,
    ...kept,
    ...(omitted === 0
      ? []
      : [`(${String(omitted)} more files are not listed here: run ls -l ${SANDBOX_FILES_DIR} and ls -l ${SANDBOX_WORK_DIR} to see them all)`]),
  ].join("\n");
};

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The bytes of one stored `view_file` result, or null when this input cannot
 * carry them.
 *
 * Re-viewed through the tool's own path, so a replayed part is built by the code
 * that built it the first time. The reference is what decides whether the answer
 * may be used: the row's digest at view time, compared against the row now, is
 * what tells one file from another file written to the same /work path since.
 * Anything else - the file deleted, the object gone, storage refusing, the
 * sandbox unable to copy the page - leaves the result its text and no part.
 *
 * One catch for every way this can raise, and it has to be one. Only two endings
 * are answers: a missing object, and the sandbox's own `failed` verdict. Storage
 * refusing a read, presigning failing, the invocation failing after its retries
 * and an answer that is not the contract's all raise - and this runs in front of
 * the turn's first token, rebuilding a result the model has already read. So a
 * rebuild that cannot happen leaves that result its text, exactly as a reference
 * past the per-turn bound does, instead of ending a turn the user is waiting on.
 * Logged in the `error` family deliberately: whatever reaches here is a fault of
 * this deployment rather than a fact about the user's file, the retryable
 * classes have already been retried, and a turn that now answers normally is the
 * only thing that would otherwise report it.
 *
 * The derivatives pass's catch is the shape this follows, with one deliberate
 * difference: that one breaks its loop and this one does not. There, the next
 * source would be sent into the same fault; here, every reference is a different
 * file, and one object this deployment cannot read must not cost the model the
 * results beside it that can be rebuilt. What that costs under a sustained fault
 * is CHAT_FILE_VIEW_REPLAYS_PER_TURN reads and the same number of records for
 * the turn, where breaking would have written one: a rebuild that raises is
 * charged against that bound like one that answered, and a repeat of the same
 * reference is answered from the attempt already made rather than read again.
 */
const expandViewCall = async (
  reference: StoredChatFileViewCall["reference"],
  context: ChatFileViewContext,
  dependencies: ChatFileManifestDependencies,
): Promise<ChatFileViewPart | null> => {
  let result: ChatFileViewResult;
  try {
    result = await dependencies.viewChatFile(
      reference.path,
      reference.page,
      context,
    );
  } catch (error) {
    dependencies.log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Chat file view replay: rebuilding one stored view_file result failed, fileId=${reference.fileId}, page=${String(reference.page)}: ${describeError(error)}`,
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
    });

    return null;
  }
  if (result.kind === "refused") {
    return null;
  }

  return result.view.reference.fileId === reference.fileId
    && result.view.reference.sha256 === reference.sha256
    ? result.view.part
    : null;
};

/**
 * What one read answers for, so a second reference to the same thing is free.
 *
 * The digest is in the key as well as the file id and the page, because the
 * digest is half of the correctness check above: a cached part may only satisfy
 * a reference whose digest it was already compared against. A write mints a new
 * file id today, so one key cannot stand for two digests - but that is a
 * property of the write path rather than of this key, and the check this key
 * stands in for is not one to leave resting on it.
 */
const buildViewCallKey = (
  reference: StoredChatFileViewCall["reference"],
): string =>
  `${reference.fileId}\u0000${reference.sha256}\u0000${String(reference.page)}`;

/**
 * Every image of this session's user messages and of the turn being answered,
 * oldest first and one entry per distinct file.
 *
 * Both are walked because the turn's own payload is the one message the input
 * may drop as a duplicate, so neither source alone names every image the input
 * can send; the same image in both is one file and takes one slot.
 *
 * A file is ordered by its last occurrence, which the resident set is the tail
 * of: an image the user attached to the turn being answered may not be the one
 * evicted in favour of strictly older ones, and re-attaching bytes the session
 * already holds resolves to that same row. Last occurrence over the stored
 * messages as much as over the turn input, and over one walk of both so the two
 * cannot drift apart: the turn's own payload is one of those messages from the
 * next turn on, so ordering a file by where it first arrived would put that
 * image back at its old position, swap the resident set a second time for one
 * re-attach, and cap the very image the user asked about.
 */
export const listChatImageReferences = (
  messages: ReadonlyArray<ServerChatMessage>,
  turnInput: ReadonlyArray<ContentPart>,
): ReadonlyArray<ImageContentPart> => {
  const walked: ReadonlyArray<ContentPart> = [
    ...messages
      .filter((message) => message.role === "user")
      .flatMap((message) => message.content),
    ...turnInput,
  ];
  const byFileId = new Map<string, ImageContentPart>();
  for (const part of walked) {
    if (part.type !== "image") {
      continue;
    }
    // Deleted before it is set, because an existing key keeps its position.
    byFileId.delete(part.fileId);
    byFileId.set(part.fileId, part);
  }

  return [...byFileId.values()];
};

const UNAVAILABLE_IMAGE: ChatImageSendState = { kind: "unavailable" };

const CAPPED_IMAGE: ChatImageSendState = { kind: "capped" };

const OVERSIZED_IMAGE: ChatImageSendState = { kind: "oversized" };

/**
 * The bytes of one resident image, or the state that says why this input carries
 * none of them.
 *
 * Two endings are answers rather than faults, and neither of them records one:
 * an object that is gone, and bytes that are not the image the part claims. The
 * second one matters because a reference is not validated anywhere else - the
 * wire checks an image's signature against its declared type while the bytes are
 * still inline, and a payload stored before that check predates it - and handing
 * the provider a part it refuses would cost the whole turn rather than this one
 * image. Answered by the attachment image checks rather than raised by them, so
 * one set of signature rules covers every image this app sends while a session
 * whose stored bytes nothing can repair does not record a fault for every one of
 * its turns, for good.
 *
 * Anything else raises, and is caught for the reason the view rebuild beside
 * this one states: this runs in front of the turn's first token, over an image
 * the model has already been shown, so a read this deployment cannot make leaves
 * that image unavailable instead of ending a turn the user is waiting on.
 */
const readResidentImage = async (
  image: ImageContentPart,
  context: ChatFileViewContext,
  dependencies: ChatFileManifestDependencies,
): Promise<ChatImageSendState> => {
  try {
    const bytes = await dependencies.readObjectBytes(
      buildChatFileObjectKey(context.sessionId, image.fileId),
    );
    if (bytes === null) {
      return UNAVAILABLE_IMAGE;
    }

    const base64Data = Buffer.from(bytes).toString("base64");

    return isSendableChatImage({ type: "image", mediaType: image.mediaType, base64Data })
      ? { kind: "resident", base64Data }
      : UNAVAILABLE_IMAGE;
  } catch (error) {
    dependencies.log({
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "agent",
      error: `Chat image replay: one image of this session cannot be sent, fileId=${image.fileId}, mediaType=${image.mediaType}: ${describeError(error)}`,
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
    });

    return UNAVAILABLE_IMAGE;
  }
};

/**
 * How every image of this input is to be sent: a row past the bytes one image may
 * be shown as answered from the row alone, the newest of the rest read together,
 * and the ones behind the bound capped without a read.
 *
 * The size claim is a property of the row rather than of residency, which is why
 * it is answered before the bound and at every index: capped tells the model to
 * call `view_file` for that path, and `view_file` refuses that row on this very
 * comparison, so a claim answered only for the rows the bound admits would hand
 * the ones behind it the single instruction their row cannot deliver. Answering
 * it first is free, because the row carries its own size and no read is needed -
 * which is also why a substituted object is never materialised as bytes and again
 * as base64 before the same ceiling refuses it.
 *
 * Together rather than one after another, because these reads are serial latency
 * in front of the turn's first token and nothing about one decides whether the
 * next is worth making: every one of them is a different object, and a
 * deployment fault that loses one must not cost the model the images beside it.
 */
const readResidentImages = async (
  images: ReadonlyArray<ImageContentPart>,
  context: ChatFileViewContext,
  dependencies: ChatFileManifestDependencies,
): Promise<ReadonlyMap<string, ChatImageSendState>> => {
  const firstResidentIndex = Math.max(images.length - CHAT_RESIDENT_IMAGES_PER_TURN, 0);
  const states = await Promise.all(images.map(async (image, index) => [
    image.fileId,
    image.sizeBytes > CHAT_ATTACHMENT_MAXIMUM_BYTES
      ? OVERSIZED_IMAGE
      : index < firstResidentIndex
        ? CAPPED_IMAGE
        : await readResidentImage(image, context, dependencies),
  ] as const));

  return new Map(states);
};

export const buildChatTurnFileContextWithDependencies = async (
  context: ChatFileViewContext,
  viewCalls: ReadonlyArray<StoredChatFileViewCall>,
  images: ReadonlyArray<ImageContentPart>,
  signal: AbortSignal | null,
  dependencies: ChatFileManifestDependencies,
): Promise<ChatTurnFileContext> => {
  // Demo mode has no database and no bucket, so this session owns no row to
  // list and no object to read.
  if (context.isDemoMode) {
    return EMPTY_CHAT_TURN_FILE_CONTEXT;
  }

  const startedAt = Date.now();
  const files = await dependencies.listSessionChatFiles(
    context.userId,
    context.workspaceId,
    context.sessionId,
  );
  const manifest = buildChatFileManifest(
    files,
    dependencies.readFunctionName() !== null,
  );
  // Read before the view results, and not inside their loop: these are the
  // user's own attachments of the messages this input sends, where a view result
  // is one the model asked for, and the turn the user abandoned is not worth
  // either read. The same signal stops both.
  const imageStateByFileId = signal?.aborted === true
    ? new Map<string, ChatImageSendState>()
    : await readResidentImages(images, context, dependencies);
  const viewParts = new Map<string, ChatFileViewPart>();
  // What this turn has already spent a read on, by distinct file and page: the
  // part the read answered with, or null where it answered with nothing. Absent
  // is the one state that still owes a read, and so the only one the bound is
  // asked about - and a failed attempt is kept rather than forgotten, because
  // the read it spent is the cost this bound exists to count.
  const attemptsByFile = new Map<string, ChatFileViewPart | null>();
  let expandedCount = 0;
  // Newest first, so the bound above spends its reads on what the model looked
  // at most recently rather than on what it has moved past.
  for (const viewCall of [...viewCalls].reverse()) {
    // The turn the user abandoned stops here: every read left is work nobody is
    // waiting for, and the items keep their text either way.
    if (signal?.aborted === true) {
      break;
    }
    // One attempt per distinct file and page, however many results showed it: a
    // model that looked at the same page twice is one object to fetch, and a
    // second result of it costs nothing and is not charged against the bound.
    // That holds for an attempt that answered with nothing too - within one turn
    // the row, the object and this deployment's fault are all the same as they
    // were a moment ago, so re-reading would buy the same answer at the price of
    // another read, and the slow answers are the failing ones.
    const key = buildViewCallKey(viewCall.reference);
    const attempt = attemptsByFile.get(key);
    if (attempt === undefined && expandedCount === CHAT_FILE_VIEW_REPLAYS_PER_TURN) {
      continue;
    }
    const part = attempt === undefined
      ? await expandViewCall(viewCall.reference, context, dependencies)
      : attempt;
    if (attempt === undefined) {
      attemptsByFile.set(key, part);
      expandedCount += 1;
    }
    if (part === null) {
      continue;
    }
    viewParts.set(viewCall.callId, part);
  }

  if (manifest !== null || viewCalls.length > 0 || images.length > 0) {
    dependencies.log({
      domain: "chat",
      action: "file_context",
      requestId: context.requestId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      fileCount: files.length,
      manifestChars: manifest === null ? 0 : manifest.length,
      viewCallCount: viewCalls.length,
      expandedCount,
      unavailableCount: viewCalls.length - viewParts.size,
      imageCount: images.length,
      residentImageCount: [...imageStateByFileId.values()].filter(
        (state) => state.kind === "resident",
      ).length,
      durationMs: Date.now() - startedAt,
    });
  }

  return { manifest, viewParts, imageStateByFileId };
};

export const buildChatTurnFileContext = async (
  context: ChatFileViewContext,
  viewCalls: ReadonlyArray<StoredChatFileViewCall>,
  images: ReadonlyArray<ImageContentPart>,
  signal: AbortSignal | null,
): Promise<ChatTurnFileContext> =>
  await buildChatTurnFileContextWithDependencies(
    context,
    viewCalls,
    images,
    signal,
    {
      listSessionChatFiles,
      viewChatFile,
      readObjectBytes: readChatFileObjectBytesIfConfigured,
      readFunctionName: readChatSandboxFunctionName,
      log,
    },
  );
