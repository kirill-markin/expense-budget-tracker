/**
 * One `bash` command of one chat session.
 *
 * just-bash is a convenience layer, not the boundary: the boundary is this
 * Lambda's microVM, an execution role with no permissions beyond its own logs,
 * the per-session pre-signed URLs the web task minted for this invocation, and
 * the host allowlist those URLs are checked against. Network is deliberately
 * left unconfigured, which is what keeps `curl` and `wget` unregistered instead
 * of merely denied.
 */
import { Bash, InMemoryFs, MountableFs, type BashOptions } from "just-bash";
import {
  describeUnsaveableFileBytes,
  describeUnsaveablePath,
  describeUnsaveableWorkBytes,
  SANDBOX_FILES_DIR,
  SANDBOX_FILES_REQUEST_MAX_BYTES,
  SANDBOX_WORK_DIR,
  SANDBOX_WORK_FILE_MEDIA_TYPE,
  SANDBOX_WORK_REQUEST_MAX_BYTES,
  quoteUntrustedSandboxText,
  quoteUntrustedSandboxValue,
  type ChatSandboxBashRequest,
  type ChatSandboxBashResponse,
  type ChatSandboxFile,
  type ChatSandboxWriteSlot,
  type ChatSandboxWrittenFile,
} from "./contract.js";
import {
  classifyObjectReadFailure,
  createPresignedObjectTransfer,
  hashObjectContent,
  OBJECT_READ_FAILURE_ADVICE,
  requireDescribedObject,
  type ObjectReadFailure,
  type SandboxObjectTransfer,
} from "./objects.js";
import {
  normalizeSandboxPath,
  parentOf,
  PresignedFs,
  type PresignedRefusalKind,
  type PresignedRefusals,
} from "./presignedFs.js";
import { RecordingWorkFs, type WorkRefusals } from "./workFs.js";

/**
 * Wall-clock budget for one command, including the python and sqlite engines:
 * the profile would leave those two at 30 s, which a 50 MB aggregation this
 * function's memory is sized for cannot finish. What is left of the Lambda's
 * two minutes is the /work diff and its uploads.
 */
export const SANDBOX_COMMAND_BUDGET_MS = 90_000;

/**
 * The `normal` profile is what real command compatibility needs; `hardened`
 * rejects a 50 MB input outright. The two raised iteration limits are the
 * profile's own 100,000 defaults, which `rg` and `awk` hit at roughly 100k rows
 * and report as a bare exit 126 with no explanation.
 */
const SANDBOX_EXECUTION_LIMITS: NonNullable<BashOptions["executionLimits"]> = {
  maxLoopIterations: 1_000_000,
  maxAwkIterations: 1_000_000,
  maxExecutionTimeMs: SANDBOX_COMMAND_BUDGET_MS,
  maxPythonTimeoutMs: SANDBOX_COMMAND_BUDGET_MS,
  maxSqliteTimeoutMs: SANDBOX_COMMAND_BUDGET_MS,
};

/**
 * Aggregate bytes /work may hold. `maxFileSystemBytes` applies only to a
 * filesystem Bash creates itself, so this one states its own ceiling: the
 * headroom over what a request may seed (SANDBOX_WORK_REQUEST_MAX_BYTES) is
 * what a command has to write with.
 */
const WORK_FS_MAX_TOTAL_BYTES = SANDBOX_WORK_REQUEST_MAX_BYTES * 2;

/** Per-stream ceiling, below the aggregate one so one stream cannot take it all. */
const MAX_STREAM_CHARS = 400_000;

/**
 * Aggregate ceiling on everything the response carries.
 *
 * A Lambda RequestResponse payload is capped at 6 MB while `maxOutputSize`
 * allows 256 MiB. JSON escaping turns one control byte into six characters, so
 * the budget stays a factor of six below the limit.
 *
 * This is the transport ceiling and nothing more: 800,000 characters against
 * the 30,000 the caller may hand a model, so it cuts this response again -
 * across every field, not only the streams - before any of it becomes prompt
 * text. The shares below are what keeps one list from taking the response; they
 * are not what keeps one list out of the model's context.
 */
export const MAX_RESPONSE_CHARS = 800_000;

/**
 * Share of the response budget each diff list may take.
 *
 * Every list grows with the number of /work files one command touched, so
 * without its own ceiling any of them can push the response past the Lambda
 * limit and turn a finished command, whose uploads already happened, into a
 * failed invocation. The three shares together leave the streams the rest.
 */
const MAX_WRITTEN_FILES_CHARS = 100_000;

const MAX_DELETED_PATHS_CHARS = 100_000;

const MAX_NOTES_CHARS = 100_000;

const capStream = (value: string, stream: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  // The marker counts against the same ceiling, so the result never exceeds it,
  // and a budget too small to hold the marker holds nothing at all.
  //
  // This is the one thing this layer writes into a stream the command owns, and
  // it belongs there: it marks where in that stream the cut happened, which a
  // note in another field could not say. It carries no claim about the
  // command's data - a command printing the same text misleads nobody - which
  // is why it did not move to `notes` with the rest of this layer's voice. It
  // does not say "sandbox" either, so that string appears nowhere in anything
  // the model sees except the notes field itself.
  const marker = `\n[${stream} truncated to its ${String(maxChars)} character budget]`;
  return maxChars < marker.length
    ? ""
    : `${value.slice(0, maxChars - marker.length)}${marker}`;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toMountRelativePath = (path: string, mountPoint: string): string =>
  normalizeSandboxPath(path.slice(mountPoint.length));

const toChatPath = (mountRelativePath: string): string =>
  `${SANDBOX_WORK_DIR}${mountRelativePath}`;

/**
 * Quoting and escaping an untrusted path or message for a note.
 *
 * Both live in contract.ts, with the whole reasoning, because the caller
 * renders these notes into a model-visible prompt and has notes of its own to
 * render the same way. One implementation of the escape set is the point: a
 * second copy on the web side would be the half that drifts, and the drift
 * would stay silent until a crafted filename forged a note.
 */
const quoteUntrusted = quoteUntrustedSandboxValue;

const quoteUntrustedText = quoteUntrustedSandboxText;

/** A /work path as a note shows it. */
const toQuotedChatPath = (mountRelativePath: string): string =>
  quoteUntrusted(toChatPath(mountRelativePath));

/** A /files path as a note shows it. */
const toQuotedFilesPath = (mountRelativePath: string): string =>
  quoteUntrusted(`${SANDBOX_FILES_DIR}${mountRelativePath}`);

/**
 * What the model should do about each kind of /files refusal.
 *
 * The shell cannot carry any of this: just-bash 3.6.0 answers a failed read of
 * an original with its own fixed "No such file or directory", so without these
 * notes a transient, recoverable failure reads as a file that is not there, and
 * a model that believes the data is absent will drop it and present an
 * incomplete answer over the user's finances as a complete one. Every kind
 * therefore says, in its own words, that the file exists and the read failed.
 *
 * Five of the seven are objects.ts's, spread in rather than written here: a
 * read failure's kind and the advice for that kind are one decision, and this
 * surface is one of three that render it - `pdf_page` and `prepare` read the
 * same objects over the same transfer and classify them the same way. The two
 * added here are the two only a command can provoke, which is why the record
 * is keyed by PresignedRefusalKind and the shared one by ObjectReadFailure.
 *
 * A Record over the union rather than a switch, so a new kind cannot be added
 * without its advice.
 */
const REFUSAL_ADVICE: Readonly<Record<PresignedRefusalKind, string>> = {
  ...OBJECT_READ_FAILURE_ADVICE,
  read_only: `was not changed: ${SANDBOX_FILES_DIR} holds the user's original files and is read-only. Copy it into ${SANDBOX_WORK_DIR} and change the copy there.`,
  memory_limit: "was not read: this command has already read as much of the originals as it may hold in memory at once. Read fewer files in one command, or process them one file at a time.",
};

/**
 * Report what the read-only mount refused, as notes beside the /work ones.
 *
 * Exported so the wording each kind gets is tested where it is written. The
 * notes are additive: the command's own stderr is left exactly as the shell
 * produced it.
 */
export const describeFileRefusals = (
  refusals: PresignedRefusals,
): ReadonlyArray<string> => [
  ...refusals.recorded.map((refusal) => {
    const quoted = refusal.detail === "" ? "" : ` (${quoteUntrustedText(refusal.detail)})`;
    return `${toQuotedFilesPath(refusal.path)} ${REFUSAL_ADVICE[refusal.kind]}${quoted}`;
  }),
  // The bound is reported rather than applied silently: a model that is told
  // only about the first twenty failures, and nothing about the rest, is back
  // to concluding that the files it heard nothing about are simply absent.
  ...(refusals.suppressedCount > 0
    ? [`${String(refusals.suppressedCount)} further ${SANDBOX_FILES_DIR} files were refused and are not named above, because one command reports a limited number of them. More files failed than the ones listed, so do not treat any ${SANDBOX_FILES_DIR} file this command did not read successfully as missing or empty.`]
    : []),
];

/**
 * What the model should do about each kind of /work refusal.
 *
 * A separate record from REFUSAL_ADVICE above, and it has to be: /work holds
 * the user's own working data rather than an untouched original, so two of the
 * kinds mean something different here. A digest mismatch on /work means the
 * scratch space and this chat's record of it have diverged - a save this chat
 * believes it made is not the object that is stored - rather than that an
 * upload is stale. And a refused /work read is a file the model itself may have
 * written in an earlier command of this same chat, so "the file exists" is a
 * fact about work it already did, not about an attachment it never saw.
 *
 * A Record over the union rather than a switch, so a new kind cannot be added
 * without its advice.
 */
const WORK_REFUSAL_ADVICE: Readonly<Record<ObjectReadFailure, string>> = {
  denied: `exists in ${SANDBOX_WORK_DIR}, and object storage answered the request for its content and refused it, which is what an expired or revoked pre-signed URL does and what a fault on its side does; the quoted status says which. Do not treat the file as missing or empty, and do not rewrite it from scratch over content you cannot read. A new tool call is signed afresh, so running the command again is worth one attempt; if it is refused again, say the file could not be read.`,
  unreachable: `exists in ${SANDBOX_WORK_DIR}, and the request for its content got no answer after three attempts. Do not treat the file as missing or empty. This is transient, so run the command again.`,
  size_mismatch: `exists in ${SANDBOX_WORK_DIR}, and its stored content is not the size this chat recorded for it, so the scratch space and this chat's record of it have diverged. Running the command again cannot change this. Tell the user this working file cannot be read, and rebuild it from ${SANDBOX_FILES_DIR} rather than from anything derived from it.`,
  digest_mismatch: `exists in ${SANDBOX_WORK_DIR}, and its stored content no longer matches the checksum this chat recorded, so the scratch space and this chat's record of it have diverged. Running the command again cannot change this: every attempt will fail the same way. Tell the user this working file cannot be read, and rebuild it from ${SANDBOX_FILES_DIR} rather than from anything derived from it.`,
  unknown: `exists in ${SANDBOX_WORK_DIR}, and reading it failed for the reason quoted. Do not treat the file as missing or empty: report that it could not be read.`,
};

/**
 * Report what the writable mount refused to read, as notes beside the /files
 * ones.
 *
 * The same shape and the same bounds as describeFileRefusals, because the
 * failure is the same: the shell answers a refused seed read with its own fixed
 * "No such file or directory", so without a note the model is told the user's
 * working file is gone. `cp` is the worst of it - it exits 0 with empty streams
 * over a lazy entry it never materialized - so this is the only channel that
 * names the source it could not read.
 */
export const describeWorkRefusals = (
  refusals: WorkRefusals,
): ReadonlyArray<string> => [
  ...refusals.recorded.map((refusal) => {
    const quoted = refusal.detail === "" ? "" : ` (${quoteUntrustedText(refusal.detail)})`;
    return `${toQuotedChatPath(refusal.path)} ${WORK_REFUSAL_ADVICE[refusal.kind]}${quoted}`;
  }),
  ...(refusals.suppressedCount > 0
    ? [`${String(refusals.suppressedCount)} further ${SANDBOX_WORK_DIR} files were refused and are not named above, because one command reports a limited number of them. More files failed than the ones listed, so do not treat any ${SANDBOX_WORK_DIR} file this command did not read successfully as missing or empty.`]
    : []),
];

/**
 * The directory the python engine mounts this filesystem under, inside its own
 * guest namespace.
 *
 * just-bash 3.6.0 runs python as CPython Emscripten and bridges its syscalls
 * back to the mounted IFileSystem through a HOSTFS mounted at `/host` with root
 * `/`. Read in the shipped bundle (`dist/bundle/chunks/worker.js`), the
 * `_should_redirect` shim prepends it to EVERY absolute path except `/lib`,
 * `/proc`, `/host` and `/_jb_http`, and the setup code finishes with
 * `os.chdir('/host' + cwd)` - so this is not a prefix on the two mounts, it is
 * a prefix on the whole namespace python sees. None of those paths exists in
 * this sandbox's namespace, and a model handed one will try to use it.
 */
const PYTHON_GUEST_MOUNT_DIR = "/host";

/** The read-only mount as python's own namespace spells it. */
const PYTHON_GUEST_FILES_DIR = `${PYTHON_GUEST_MOUNT_DIR}${SANDBOX_FILES_DIR}`;

/**
 * A CPython errno message, which is the only shape whose paths are rewritten.
 *
 * The invariant this keeps: THIS LAYER DOES NOT ALTER A STREAM THE COMMAND
 * OWNS, IN EITHER DIRECTION. Keying the rewrite on the `/host` prefix instead
 * broke that in both directions at once - it edited a `/host/files...` string
 * that came out of the user's own data (`cat /files/notes.txt`), and it still
 * left every guest path outside the two mounts in place, which is most of them.
 * Keying it on the message shape fixes both: the exception is one the python
 * engine authors, not the command, and it covers every path python reports.
 *
 * `[Errno <n>]` is the anchor because CPython's `OSError.__str__` always emits
 * it and nothing else here does. Matching from the anchor rather than from the
 * start of the line is also what keeps this linear: `^.*\[Errno \d+\]` would
 * backtrack across a 400,000-character line of ordinary output.
 *
 * A command can of course print `[Errno 2] x: '/host/files/a'` itself and have
 * it rewritten. That costs nothing: it edits text the command invented, carries
 * no claim of its own, and the only thing it can remove is a literal `/host`
 * prefix inside a quoted path on that line.
 */
const PYTHON_ERRNO_MESSAGE = /\[Errno \d+\][^\n]*/g;

/**
 * The body of a CPython `repr`, under one delimiter: raw characters and
 * backslash escapes.
 *
 * One definition, used by both patterns below, for the reason refusalLog.ts
 * exists: the rewrite and the detector have to agree on where a quoted path
 * ends, and an escaped quote is exactly where a second copy would disagree.
 * `'/host/files/a\'b"c'` is one path, not a path ending at the apostrophe.
 *
 * The two alternatives are disjoint on their first character, so a body is
 * consumed deterministically and nothing backtracks. Measured on the worst
 * shapes either pattern can be handed: 40,000 escaped-quote starts on one line
 * cost 4.5 ms, one unterminated 200,000-escape body 0.7 ms, and 400,000
 * characters with no match 0.1 ms.
 */
const pythonReprBody = (delimiter: string): string =>
  `(?:[^${delimiter}\\\\\n]|\\\\.)*`;

/**
 * The escape set CPython's `repr` emits for a `str`, and nothing wider.
 *
 * `repr` escapes the delimiter and the backslash, renders tab, newline and
 * carriage return as `\t`, `\n`, `\r`, and everything else unprintable as
 * `\xNN`, `\uNNNN` or `\UNNNNNNNN`. It never emits `\a`, `\b`, `\f` or `\v`,
 * and never escapes the delimiter it did not choose - a name holding `'` is
 * double-quoted, which is why that case needs no `\"` here.
 *
 * Deliberately exact rather than tolerant: an escape outside this set means
 * the text is not a repr this decoder understands, and a path guessed out of it
 * would be a path nothing touched.
 */
const PYTHON_REPR_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Sticky, so a body with many escapes is decoded in one pass over it. */
const PYTHON_REPR_ESCAPE = /\\(?:([\\'nrt])|x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/y;

const MAX_UNICODE_CODE_POINT = 0x10ffff;

/**
 * The filename a repr body stands for, or null when it is not one.
 *
 * Decoding rather than rejecting, because rejecting loses real refusals:
 * `/files/back\slash.csv` is a path chat_files accepts - describeUnsaveablePath
 * bars only `//`, a trailing slash and relative segments - and `repr` renders
 * it `'/host/files/back\\slash.csv'`, which an opaque capture cannot tell from
 * a truncation. A genuine write refusal of a file that exists producing no note
 * is this channel's own failure mode, so it is not available as a trade.
 */
const decodePythonRepr = (reprBody: string): string | null => {
  let decoded = "";
  let index = 0;
  for (;;) {
    const escapeAt = reprBody.indexOf("\\", index);
    if (escapeAt === -1) {
      return decoded + reprBody.slice(index);
    }
    decoded += reprBody.slice(index, escapeAt);
    PYTHON_REPR_ESCAPE.lastIndex = escapeAt;
    const escape = PYTHON_REPR_ESCAPE.exec(reprBody);
    if (escape === null) {
      return null;
    }
    const [matched, simple, hex2, hex4, hex8] = escape;
    if (simple === undefined) {
      const codePoint = Number.parseInt(String(hex2 ?? hex4 ?? hex8), 16);
      if (codePoint > MAX_UNICODE_CODE_POINT) {
        return null;
      }
      decoded += String.fromCodePoint(codePoint);
    } else {
      decoded += PYTHON_REPR_SIMPLE_ESCAPES[simple];
    }
    index = escapeAt + matched.length;
  }
};

/**
 * One quoted guest path inside such a message, under either delimiter.
 *
 * Both are needed, and not for an adversarial reason: CPython renders a
 * filename with `repr`, which switches to double quotes as soon as the name
 * contains a single quote. `/files` names are filenames the user uploaded, so
 * one apostrophe is enough - `"/host/work/Kirill's.csv"` came back verbatim
 * while only `'...'` was matched, which is exactly the nonexistent path this
 * rewrite exists to remove. Each branch excludes only its own delimiter, so the
 * apostrophe inside a double-quoted name is kept.
 *
 * Every quoted path on the line is rewritten, not just the first, because
 * CPython renders a two-path error as `'<src>' -> '<dst>'` and both halves are
 * guest paths. Read against the 3.6.0 shim: the two-path syscalls a script
 * calls directly - `os.rename`, `os.replace`, `os.link`, `os.symlink`,
 * `Path.rename`, `Path.replace` - are absent from it, so those are not
 * redirected at all and report the real sandbox path, with nothing to rewrite.
 * `shutil.move` is in the shim, though, and redirects both of its arguments
 * before its own internal `os.rename` sees them, so that one does reach this
 * form. Not run, because this workspace's tests do not boot CPython; handling
 * it costs one quantifier either way.
 */
const PYTHON_GUEST_QUOTED_PATH = new RegExp(
  `'${PYTHON_GUEST_MOUNT_DIR}(/${pythonReprBody("'")})'`
  + `|"${PYTHON_GUEST_MOUNT_DIR}(/${pythonReprBody('"')})"`,
  "g",
);

/**
 * Put the paths of a CPython errno message back into this sandbox's namespace.
 *
 * Nothing outside such a message is touched, which is the whole point: a
 * command that prints `/host/files/x` out of a file, or greps for it, gets its
 * own bytes back unchanged.
 */
const rewritePythonGuestPaths = (value: string): string =>
  value.replace(
    PYTHON_ERRNO_MESSAGE,
    (message) => message.replace(
      PYTHON_GUEST_QUOTED_PATH,
      // The delimiter is put back as it was found: the rest of the line is the
      // engine's own rendering and only the prefix is this layer's business.
      (_matched, singleQuoted: string | undefined, doubleQuoted: string | undefined) =>
        singleQuoted === undefined ? `"${String(doubleQuoted)}"` : `'${singleQuoted}'`,
    ),
  );

/**
 * A python write to /files that the python engine refused on its own.
 *
 * Measured against 3.6.0: the engine's write path does reach the mounted
 * filesystem, but CPython Emscripten checks the entry's mode inside its own
 * guest VFS first, and PresignedFs reports 0444 files inside 0555 directories.
 * So the write is refused before PresignedFs is called, the mount records no
 * refusal, and the model gets a bare traceback naming the internal guest path
 * and an errno its own strerror renders as both "Permission denied" and, by
 * number, as ENOENT - "the file does not exist", for a file that exists and is
 * read-only. There is no hook to route the check through the mount, so the
 * shape is detected here instead and recorded into the mount it belongs to.
 *
 * Both repr delimiters, for the reason above: one apostrophe in an uploaded
 * filename is enough to switch CPython to double quotes.
 *
 * WHAT THE ANCHORS BUY, EXACTLY: one real CPython message cannot yield a second
 * refusal. `repr` escapes a newline inside a filename, so a genuine message is
 * always one line, and stopping at its first quoted path means a name carrying
 * `'; Permission denied: '/host/files/evil` adds nothing - measured, one record
 * for one failure.
 *
 * WHAT THEY DO NOT BUY: a command can print its own lines, and `^` under `m`
 * matches after each of them, so `printf` into stderr can mint one `read_only`
 * note per line up to the shared bound. That is a correction to an earlier,
 * wider claim here rather than a hole worth a heuristic: the advice those notes
 * carry is true of every /files path - the mount really is read-only - real
 * refusals are recorded before this runs so the shared bound still keeps them,
 * the dedup cannot be subverted, and `execCommand` yields an empty stderr
 * whenever `exec` threw, so this route has no input at all when something
 * actually propagated. Gating the scan on the python engine having run would
 * close it outright and was checked: `BashExecResult` in 3.6.0 carries
 * `stdout`, `stderr`, `exitCode`, `env` and a `metadata` field documented as
 * the shape of stdout, nothing about which engines ran; the `coverage` hook is
 * fuzzing instrumentation that the python3 command emits nothing into, only
 * bash expansion, awk and sed do; and `WorkerLifecycle` is not exported. Worth
 * re-checking on a just-bash upgrade. A heuristic over the command text is
 * deliberately not the fallback.
 */
const PYTHON_FILES_WRITE_REFUSAL = new RegExp(
  `^PermissionError: \\[Errno \\d+\\] [^:'"\n]*: `
  + `(?:'${PYTHON_GUEST_FILES_DIR}(/${pythonReprBody("'")})'`
  + `|"${PYTHON_GUEST_FILES_DIR}(/${pythonReprBody('"')})")`,
  "gm",
);

/**
 * The mount-relative path a captured repr body names, or null when it names
 * nothing this mount can hold.
 *
 * The decode comes first, then the FULL guest path is folded and the mount
 * prefix stripped - in that order, because folding the capture on its own
 * cannot see what it would escape into. Both `..` shapes are then exact rather
 * than refused: `/host/files/sub/../x.txt` resolves to `/x.txt`, which is the
 * real file the write was refused on, and `/host/files/a/../../files/b`
 * resolves to `/b` rather than the nonexistent `/files/files/b` that folding
 * the capture alone produced. The shim is why `..` arrives at all: it prefixes
 * the string the script passed without resolving it, and the guest then
 * resolves it back inside `/host/files`, whose 0555 parent is what refuses.
 *
 * Null for the two things that are not a file of this mount. A path that folds
 * out of the mount - `/host/files/../../etc/passwd` - is not ours to report.
 * And a path that folds to the mount directory itself, which `'/host/files/'`
 * does, is not a file: the note would tell the model to copy the mount into
 * /work, which is nonsense advice even though no sentence in it is false. Both
 * fall out of requiring the folded path to keep the prefix AND a slash after
 * it.
 */
const readGuestFilesPath = (reprBody: string): string | null => {
  const decoded = decodePythonRepr(reprBody);
  if (decoded === null) {
    return null;
  }
  const resolved = normalizeSandboxPath(`${PYTHON_GUEST_FILES_DIR}${decoded}`);
  if (!resolved.startsWith(`${PYTHON_GUEST_FILES_DIR}/`)) {
    return null;
  }

  return resolved.slice(PYTHON_GUEST_FILES_DIR.length);
};

/**
 * Record what python refused on the read-only mount, into that mount's own log.
 *
 * One log, so there is one bound, one dedup and one suppressed count for the
 * command however its refusals arrived: a second log of its own produced two
 * independent twenty-refusal bounds and two different "N further /files files
 * were refused" notes about one command, which is not what the bound claims to
 * mean. Nothing is rendered here - describeFileRefusals reads the mount
 * afterwards and cannot tell the two routes apart, which is correct, because
 * the model should not have to either.
 *
 * Must run before the mount's refusals are read, and takes the command's own
 * stderr before `assembleBashResponse` rewrites the guest paths out of it.
 */
export const recordPythonWriteRefusals = (
  filesFs: PresignedFs,
  stderr: string,
): void => {
  for (const match of stderr.matchAll(PYTHON_FILES_WRITE_REFUSAL)) {
    // Either delimiter's body, through the one decode: a double-quoted repr
    // carries backslash escapes too, so both branches need it.
    const path = readGuestFilesPath(match[1] ?? match[2]);
    if (path !== null) {
      filesFs.recordBypassedRefusal(path, "read_only", "");
    }
  }
};

/**
 * Create one path's ancestor directories, one level per call.
 *
 * InMemoryFs's own `mkdir` with `recursive: true` recurses once per missing
 * level, so seeding a path through it was the deepest recursion left in this
 * workspace after the /work walk got its own stack - and, measured on Node
 * 24.19, a tighter limit than the shell's: a warm child created and uploaded a
 * path 3903 directories deep, while a cold child, which is what a session
 * change forks, threw RangeError seeding that same path from 3300. Since a
 * command's own writes are what fill `chat_files`, that combination turned one
 * deep `mkdir -p` into a chat where every later command - `echo hi` included -
 * failed before running, with no way for the model to delete the file it
 * created. Each call here has its parent already in place, so the recursion
 * inside it is one level deep whatever the path. PresignedFs's constructor
 * builds its ancestor set the same way, which is why /files was never exposed.
 */
const createAncestorDirectories = (workFs: RecordingWorkFs, path: string): void => {
  let prefix = "";
  for (const segment of path.split("/").slice(1, -1)) {
    prefix = `${prefix}/${segment}`;
    workFs.mkdirSync(prefix, { recursive: true });
  }
};

/**
 * Seed /work with the files this chat already has, as lazy entries: a command
 * that never touches a file never downloads it. The request schema rejects a
 * path that is also another path's parent directory, so the directory creation
 * below cannot collide with a file.
 */
export const createWorkFs = (
  entries: ReadonlyArray<ChatSandboxFile>,
  transfer: SandboxObjectTransfer,
): RecordingWorkFs => {
  const workFs = new RecordingWorkFs(WORK_FS_MAX_TOTAL_BYTES);
  for (const entry of entries) {
    const path = toMountRelativePath(entry.path, SANDBOX_WORK_DIR);
    createAncestorDirectories(workFs, path);
    workFs.seedFile(
      path,
      { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs },
      // Recorded and rethrown, exactly as PresignedFs does it: the command
      // fails the way it already does, with the shell's own message, and the
      // response carries why. This closure is the only place that knows both
      // the path and the failure - every reader above it sees nothing but
      // "No such file or directory".
      //
      // The path recorded is the SEEDED one, closed over here, not whatever
      // path the read came through. That is what makes a refusal for a file the
      // command moved away land on the name the chat still holds - and it is
      // why diffWorkFiles must read the refusals after its candidate loop, not
      // before. See the read point there.
      async () => {
        try {
          return requireDescribedObject(
            entry.path,
            await transfer.readObject(entry.getUrl),
            entry,
          );
        } catch (error) {
          workFs.recordRefusal(path, classifyObjectReadFailure(error), describeError(error));
          throw error;
        }
      },
    );
  }

  return workFs;
};

type WorkWalk = Readonly<{
  /** Regular files, the only entries with an object to persist. */
  files: Array<string>;
  /** Symlinks, which the walk reaches but cannot persist. */
  symlinks: Array<string>;
  /** Every path the walk could see, whatever its type. */
  reached: Set<string>;
}>;

/**
 * Walk the whole surviving /work tree into an accumulator.
 *
 * Iterative, with its own stack, and with no depth bound of its own. A bound
 * used to be here so a self-nesting script could not recurse without end, and
 * it mis-fired: a /work file seeded deeper than it put a note on every command
 * of that session, including `echo hi`, and left that file unsaveable, so `echo
 * changed >` it returned exit 0 and uploaded nothing - the user's write lost in
 * silence, which is the defect this whole layer exists to prevent. It was also
 * not what made the walk safe: this filesystem is a map keyed by literal path
 * and the walk descends only into entries the listing itself calls directories,
 * so no symlink is traversed, there is no cycle to follow, every entry is
 * visited once and the tree is finite.
 *
 * What depth did threaten was this function's own call stack, which an explicit
 * stack removes. It threatened the rest of the system too, and still would: the
 * limit now lives where it can be stated rather than discovered, as
 * SANDBOX_PATH_MAX_DEPTH on what a request may seed and on what the diff below
 * will save.
 *
 * The accumulator is passed in rather than returned and spread, because
 * spreading a subtree as call arguments throws RangeError above roughly 100,000
 * entries, which would lose every change the command made.
 */
const walkWorkFiles = async (
  workFs: RecordingWorkFs,
  root: string,
  walk: WorkWalk,
): Promise<void> => {
  const pending: Array<string> = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    // Entry types come from the in-memory directory listing, so walking the
    // tree materializes nothing.
    for (const entry of await workFs.readdirWithFileTypes(directory)) {
      const path = directory === "/" ? `/${entry.name}` : `${directory}/${entry.name}`;
      walk.reached.add(path);
      if (entry.isDirectory) {
        pending.push(path);
        continue;
      }
      if (entry.isFile) {
        walk.files.push(path);
        continue;
      }
      if (entry.isSymbolicLink) {
        walk.symlinks.push(path);
      }
    }
  }
};

/**
 * Report entries the directory tree cannot reach.
 *
 * The filesystem keys an entry by its literal path and leaves a non-directory
 * ancestor alone, so `ln -s /files l && echo x > l/new.txt` stores `/l/new.txt`
 * under a symlink the walk must not descend into. Such a file is real and lost,
 * so it is named rather than silently dropped from a successful-looking command.
 */
const describeUnreachableEntries = (
  workFs: RecordingWorkFs,
  walk: WorkWalk,
): ReadonlyArray<string> => {
  const unreachable = workFs.getAllPaths()
    .filter((path) => path !== "/" && !walk.reached.has(path))
    .sort();
  if (unreachable.length === 0) {
    return [];
  }

  return [
    `${String(unreachable.length)} ${SANDBOX_WORK_DIR} entries were not saved because a path component is a file or a symlink rather than a directory, starting with ${unreachable.slice(0, 3).map(toQuotedChatPath).join(", ")}`,
  ];
};

/**
 * Report symlinks the command created.
 *
 * A symlink has no object to persist, so it lives and dies with the command:
 * `ln -s big.csv latest.csv` is gone by the next one. It is a change the
 * command made, so it is named rather than silently dropped.
 *
 * An empty directory is the same kind of loss and is deliberately not reported:
 * the next command's first write under it recreates it, so nothing the model
 * would then observe is missing, while a symlink's target cannot be
 * reconstructed from anything the next command has.
 */
const describeUnsavedSymlinks = (
  workFs: RecordingWorkFs,
  walk: WorkWalk,
): ReadonlyArray<string> => {
  const created = walk.symlinks.filter((path) => workFs.wasMutated(path)).sort();
  if (created.length === 0) {
    return [];
  }

  return [
    `${String(created.length)} ${SANDBOX_WORK_DIR} entries were not saved because a symlink has no content to save, starting with ${created.slice(0, 3).map(toQuotedChatPath).join(", ")}`,
  ];
};

export type WorkDiff = Readonly<{
  writtenFiles: ReadonlyArray<ChatSandboxWrittenFile>;
  deletedPaths: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
}>;

/**
 * Persist what the command changed under /work.
 *
 * Only the paths the command wrote, and paths the request did not seed, are
 * read and digested; everything else keeps its lazy entry and costs nothing.
 * Each path's own failure becomes a note, so one unsaved file neither hides the
 * command's output nor stops the remaining files from being saved.
 */
/**
 * What the request already stored for one /work path.
 *
 * The size is here because the diff has to know what this chat would weigh
 * after the command: a file it does not re-save keeps the bytes the request
 * described, and that total is what the next command has to seed.
 *
 * A contract with the caller, which does not exist yet, so it is written down
 * rather than assumed: these numbers are what the request said, not what the
 * stored objects measure, and the diff never reads an object it does not
 * otherwise need. Understated `sizeBytes` therefore understates the total, and
 * the save side will accept a set whose real bytes are over the ceiling. That
 * is brick-free only because the web task feeds these same numbers back when it
 * seeds the next command, so both sides are wrong by the same amount and agree.
 * A caller that seeds from the request but validates against real
 * `ContentLength` would break that agreement and reintroduce the chat no
 * command can run.
 */
export type WorkBaselineEntry = Readonly<{ sha256: string; sizeBytes: number }>;

type ReportedDeletions = Readonly<{
  deletedPaths: ReadonlyArray<string>;
  /** Missing paths kept in the chat, whose bytes the chat therefore still holds. */
  withheldPaths: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
}>;

/**
 * Report what /work no longer holds, and never report a file this command could
 * not read.
 *
 * The caller removes a chat_files row for every path in `deletedPaths`, so a
 * wrong entry is not a wrong note - it is the permanent loss of the user's
 * working file. The two facts that have to be combined are both on this side,
 * which is why the decision is: a refused read means the file may well still be
 * there, and the only thing this command actually learned about it is that it
 * could not be read. `mv /work/data.csv /work/new.csv` over a refused GET is
 * the shape that makes it concrete - InMemoryFs moves the lazy entry without
 * materializing it, so the source leaves the tree and looks deleted while the
 * destination is merely "not saved", and a transient 403 would have ended as a
 * deleted file.
 *
 * What withholding costs, stated correctly: the row survives, so the next
 * command seeds the path again and the file is simply back. It is reported
 * deleted only when a later command removes it WITHOUT reading it, which is
 * why both notes below tell the model to run the delete again on its own. An
 * earlier version of this comment claimed the next command would find it gone
 * and report it then, which is not what seeding does.
 *
 * The withheld paths are returned, not only their notes, because their bytes
 * have to be charged to the chat: the caller keeps those rows, so the next
 * request seeds them, and a projection that counted them as gone would accept a
 * save that puts the chat past what one command may seed - a chat where nothing
 * runs at all.
 *
 * A suppressed refusal names no path, so when the bound dropped any, every
 * missing path is withheld. That is the same reasoning the bound itself carries
 * - what it costs is detail, never the fact that something failed - and the
 * alternative is deleting a row whose refusal happened to be the twenty-first.
 */
const describeDeletions = (
  refusals: WorkRefusals,
  baselineByPath: ReadonlyMap<string, WorkBaselineEntry>,
  survivingPathSet: ReadonlySet<string>,
): ReportedDeletions => {
  // The walk visits the whole tree, so a baseline path missing from it is
  // genuinely absent rather than merely unexplored - but absent is not the same
  // as deleted when this command could not read it.
  const missingPaths = [...baselineByPath.keys()]
    .filter((path) => !survivingPathSet.has(path));
  if (refusals.suppressedCount > 0) {
    return {
      deletedPaths: [],
      withheldPaths: missingPaths,
      notes: missingPaths.length === 0
        ? []
        : [`${String(missingPaths.length)} ${SANDBOX_WORK_DIR} files are no longer there and none of them is reported as deleted: more reads failed than this command could name, so it cannot tell a file that was deleted from one it could not read. All of them are still in this chat and will be there again for the next command, so run each delete you meant on its own, without reading the file first.`],
    };
  }

  const refusedPaths = new Set(refusals.recorded.map((refusal) => refusal.path));
  const withheldPaths = missingPaths.filter((path) => refusedPaths.has(path));

  return {
    deletedPaths: missingPaths
      .filter((path) => !refusedPaths.has(path))
      .map(toChatPath),
    withheldPaths,
    notes: withheldPaths.map(
      (path) => `${toQuotedChatPath(path)} is no longer at that path and is not reported as deleted, because reading it failed in this command: a file that could not be read may still be there. It is still in this chat and will be there again for the next command, so if you meant to delete it, run the delete again on its own, without reading it first.`,
    ),
  };
};

export const diffWorkFiles = async (
  workFs: RecordingWorkFs,
  baselineByPath: ReadonlyMap<string, WorkBaselineEntry>,
  writeSlots: ReadonlyArray<ChatSandboxWriteSlot>,
  transfer: SandboxObjectTransfer,
): Promise<WorkDiff> => {
  const walk: WorkWalk = { files: [], symlinks: [], reached: new Set() };
  try {
    await walkWorkFiles(workFs, "/", walk);
  } catch (error) {
    // Nothing in the walk raises by design; this is the backstop for a
    // directory listing that fails for a reason this layer does not know, where
    // continuing would report every surviving file as deleted.
    return {
      writtenFiles: [],
      deletedPaths: [],
      notes: [`nothing from ${SANDBOX_WORK_DIR} was saved: ${quoteUntrustedText(describeError(error))}`],
    };
  }

  const survivingPaths: ReadonlyArray<string> = walk.files;
  const notes: Array<string> = [
    ...describeUnreachableEntries(workFs, walk),
    ...describeUnsavedSymlinks(workFs, walk),
  ];
  const candidates = survivingPaths
    .filter((path) => !baselineByPath.has(path) || workFs.wasMutated(path))
    .sort();
  const writtenFiles: Array<ChatSandboxWrittenFile> = [];
  let nextSlotIndex = 0;

  // Measured before anything is judged, because the byte ceiling is a property
  // of the final state and must not depend on the order the candidates are
  // walked in. Judging one at a time against a running total weighed an
  // alphabetically earlier file against bytes the same command had already
  // discarded: `z.bin` 512 MB replaced by 1 byte plus a new 2-byte `a.bin`
  // refused `a.bin`, while the same final 3 bytes reached by replacing `a.bin`
  // and adding `y.bin` saved both. Same state, different answer, and the note
  // told the model to delete files it had just deleted.
  const pending: Array<Readonly<{
    path: string;
    content: Uint8Array;
    sha256: string;
    previousBytes: number;
  }>> = [];
  for (const path of candidates) {
    // Refused here as well as in the request schema, through the same
    // predicate, and that is the point: a path this sandbox saved but would not
    // accept back is a file the next command of the chat could never seed,
    // which is how one deep write used to leave a chat where nothing ran.
    const unsaveable = describeUnsaveablePath(toChatPath(path));
    if (unsaveable !== null) {
      notes.push(
        `${toQuotedChatPath(path)} cannot be saved, and no later command will be able to save it either: ${unsaveable}. Move it to a shorter path under ${SANDBOX_WORK_DIR}.`,
      );
      continue;
    }
    const previous = baselineByPath.get(path);
    const previousBytes = previous === undefined ? 0 : previous.sizeBytes;
    try {
      const content = await workFs.readFileBuffer(path);
      const sha256 = hashObjectContent(content);
      if (previous !== undefined && previous.sha256 === sha256) {
        continue;
      }
      const tooLarge = describeUnsaveableFileBytes(content.byteLength);
      if (tooLarge !== null) {
        notes.push(`${toQuotedChatPath(path)} was not saved: ${tooLarge}`);
        continue;
      }
      pending.push({ path, content, sha256, previousBytes });
    } catch (error) {
      notes.push(`${toQuotedChatPath(path)} was not saved: ${quoteUntrustedText(describeError(error))}`);
    }
  }

  /**
   * This command's /work refusals, read after the loop above because THE LOOP
   * ITSELF RECORDS REFUSALS FOR MISSING PATHS. Do not hoist this.
   *
   * The seed loader records at the path it was SEEDED at, not at the path being
   * read - it closes over `createWorkFs`'s own `path` - and the two differ
   * exactly when the command moved a file. After `mv /work/data.csv
   * /work/new.csv` over a refused GET, nothing is read until this diff reads
   * the new path, and that read records a refusal for `/data.csv`: a path that
   * has left the tree and is therefore in the missing set. So the per-path
   * withhold below depends on refusals this loop produced, and reading before
   * the loop would report a transient 403's `mv` source as deleted - the caller
   * drops its chat_files row and the user's working file is gone for good.
   * `suppressedCount` is not what is at stake here; the withheld set itself is.
   *
   * The same read also feeds the byte charge below, from this one snapshot, so
   * the bytes and the reported deletions can never be decided from different
   * states.
   *
   * This is not the only read: `runChatSandboxBash` reads them again to render
   * the notes. That is safe for one reason worth writing down - nothing records
   * a /work refusal between the two. The walk uses directory listings only, the
   * save loop uploads content it already holds, and no other reader of a seed
   * runs after this point. A later edit that reads a seed in between has to
   * move this read, not add a third.
   */
  const deletions = describeDeletions(
    workFs.getRefusals(),
    baselineByPath,
    new Set(survivingPaths),
  );

  /**
   * What the chat already weighs, which is what the next command has to seed.
   *
   * Every surviving file the request described, because a file this diff
   * declines to save keeps its old object and so keeps its old size - plus
   * every file withheld from `deletedPaths` above, because the caller keeps
   * those rows and will seed them again. Counting a withheld file as gone broke
   * the one agreement WorkBaselineEntry's own doc requires: five 100 MB files,
   * one read refused and removed, one new 100 MB file saved against a projected
   * 500 MB, and the next request carried 600 MB and was rejected by the request
   * schema - a chat where no command could run to delete anything.
   */
  const chargedPaths = new Set([...survivingPaths, ...deletions.withheldPaths]);
  let storedBytes = 0;
  for (const [path, entry] of baselineByPath) {
    if (chargedPaths.has(path)) {
      storedBytes += entry.sizeBytes;
    }
  }

  /**
   * The aggregate the per-file limit says nothing about, judged once against
   * what the chat would actually hold.
   *
   * Six legal 100 MB writes fit the filesystem, whose ceiling is deliberately
   * larger than the seed ceiling, and used to all be saved - leaving a chat
   * whose next seed was refused and which no later command could run. When the
   * whole set fits, every candidate is saved whatever order they came in. When
   * it does not, something has to go, and the sequential rule below picks who:
   * order-dependent, but only in a case where a refusal is unavoidable, and
   * conservative in the one direction that matters - it counts a file it
   * declines to save as keeping the bytes it already had, so it can never
   * accept a set that bricks the chat.
   *
   * The note states the condition and prescribes nothing, deliberately. This
   * layer cannot know whether the chat can still run a command: its caller may
   * have failed to remove a row, in which case its own note has just said the
   * chat can run nothing further and cannot delete its own files - and an
   * instruction here to delete some would be two notes in one result telling
   * the model opposite things, which is the defect this channel exists to
   * prevent. The remedy belongs to the layer that knows, which is the caller.
   */
  const projectedBytes = pending.reduce(
    (total, save) => total + save.content.byteLength - save.previousBytes,
    storedBytes,
  );
  const projectedOverBudget = describeUnsaveableWorkBytes(projectedBytes);

  for (const save of pending) {
    if (projectedOverBudget !== null) {
      const stillOverBudget = describeUnsaveableWorkBytes(
        storedBytes - save.previousBytes + save.content.byteLength,
      );
      if (stillOverBudget !== null) {
        notes.push(
          `${toQuotedChatPath(save.path)} was not saved: ${projectedOverBudget}, and saving it would stop every later command of this chat from running. ${SANDBOX_WORK_DIR} has to hold less before anything more can be written to it.`,
        );
        continue;
      }
    }
    const slot = writeSlots[nextSlotIndex];
    if (slot === undefined) {
      notes.push(
        `${toQuotedChatPath(save.path)} was not saved: one command can save at most ${String(writeSlots.length)} files`,
      );
      continue;
    }
    nextSlotIndex += 1;
    storedBytes = storedBytes - save.previousBytes + save.content.byteLength;
    try {
      await transfer.writeObject(slot.putUrl, SANDBOX_WORK_FILE_MEDIA_TYPE, save.content);
      writtenFiles.push({
        path: toChatPath(save.path),
        slotId: slot.slotId,
        sizeBytes: save.content.byteLength,
        sha256: save.sha256,
      });
    } catch (error) {
      // The upload failed, so the file keeps whatever object it had: give its
      // bytes back to the total rather than charging the chat for a write that
      // did not happen.
      storedBytes = storedBytes - save.content.byteLength + save.previousBytes;
      notes.push(
        `${toQuotedChatPath(save.path)} was not saved: ${quoteUntrustedText(describeError(error))}`,
      );
    }
  }

  return {
    writtenFiles,
    deletedPaths: deletions.deletedPaths,
    notes: [...notes, ...deletions.notes],
  };
};

/** The enclosing brackets a JSON array costs on top of its entries. */
const JSON_ARRAY_CHARS = 2;

/** What one entry of a response list costs: its JSON and its separator. */
const jsonEntryChars = (entry: ChatSandboxWrittenFile | string): number =>
  JSON.stringify(entry).length + 1;

/**
 * Keep the entries that fit in `maxChars` and count the rest.
 *
 * One entry that does not fit is skipped rather than ending the list, because
 * these entries are not interchangeable: a single oversized one - a note about
 * a 100,000-character filename is 200,000 characters by itself - would
 * otherwise take every note after it with it, including the ones saying a file
 * was not saved. The caller turns the count into a note, so a partial list is
 * visible to the model instead of looking like the whole story.
 */
const takeWithinBudget = <T>(
  entries: ReadonlyArray<T>,
  maxChars: number,
  measureChars: (entry: T) => number,
): Readonly<{ kept: ReadonlyArray<T>; droppedCount: number }> => {
  const kept: Array<T> = [];
  let usedChars = 0;
  for (const entry of entries) {
    const entryChars = measureChars(entry);
    if (usedChars + entryChars > maxChars) {
      continue;
    }
    usedChars += entryChars;
    kept.push(entry);
  }

  return { kept, droppedCount: entries.length - kept.length };
};

type ReportedDiff = Readonly<{
  writtenFiles: ReadonlyArray<ChatSandboxWrittenFile>;
  deletedPaths: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
}>;

/** Fit the whole /work diff, notes included, into the response budget. */
const reportDiffWithinBudget = (diff: WorkDiff): ReportedDiff => {
  const writtenFiles = takeWithinBudget(
    diff.writtenFiles,
    MAX_WRITTEN_FILES_CHARS - JSON_ARRAY_CHARS,
    jsonEntryChars,
  );
  const deletedPaths = takeWithinBudget(
    diff.deletedPaths,
    MAX_DELETED_PATHS_CHARS - JSON_ARRAY_CHARS,
    jsonEntryChars,
  );
  const notes = takeWithinBudget(
    diff.notes,
    MAX_NOTES_CHARS - JSON_ARRAY_CHARS,
    jsonEntryChars,
  );
  const overflowNotes = [
    ...(writtenFiles.droppedCount > 0
      ? [`${String(writtenFiles.droppedCount)} more files were saved but left out of writtenFiles, which is now past its share of the response budget`]
      : []),
    ...(deletedPaths.droppedCount > 0
      ? [`${String(deletedPaths.droppedCount)} more deleted paths were left out of deletedPaths, which is now past its share of the response budget`]
      : []),
    // Not "notes about /work": the list holds whatever this layer had to say
    // about the command, and the entry that did not fit may have been the one
    // saying it never ran.
    ...(notes.droppedCount > 0
      ? [`${String(notes.droppedCount)} more notes from the sandbox about this command were dropped from this response`]
      : []),
  ];

  return {
    writtenFiles: writtenFiles.kept,
    deletedPaths: deletedPaths.kept,
    notes: [...notes.kept, ...overflowNotes],
  };
};

export type ExecOutcome = Readonly<{
  stdout: string;
  /** The command's own stderr; nothing this layer wrote belongs here. */
  stderr: string;
  exitCode: number;
  /**
   * The error `exec` raised, when the command did not run to completion, as it
   * was raised: the caller decides whether it still needs saying, and only it
   * knows whether a mount already explained the same event.
   */
  failure: string | null;
}>;

/**
 * A rejected write to the read-only /files mount leaves `exec()` as an uncaught
 * EROFS error rather than a non-zero exit code, so every execution is turned
 * into tool output here instead of failing the invocation. Measured, because
 * the note this produces stands down in one case and the population matters: an
 * execution limit does NOT arrive here - a loop, a `seq`, the deadline, a
 * `sleep` and a python script all end as exit 124 or 126 with their own
 * stderr. What does is a /files EROFS, an ENOSPC from the /work filesystem, and
 * a throw from inside an engine.
 *
 * Such an error is this layer speaking, not the command, so it becomes a note
 * rather than a line of the command's stderr.
 */
const execCommand = async (bash: Bash, command: string): Promise<ExecOutcome> => {
  try {
    const result = await bash.exec(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      failure: null,
    };
  } catch (error) {
    return { stdout: "", stderr: "", exitCode: 1, failure: describeError(error) };
  }
};

/**
 * Say that the command stopped early, unless a mount already said why.
 *
 * A refused write to /files arrives twice: it raises out of `exec`, and the
 * mount records it as a refusal. That is the most routine way this layer has
 * anything to say at all, so reporting both would make two notes about one
 * event the normal case. The refusal is the better of the two - it names the
 * file and says to copy it into /work, where this one only repeats the errno.
 *
 * Measured, so the risk of standing down is known rather than assumed: an
 * execution limit never reaches here. A loop, a `seq`, the deadline, a `sleep`
 * and a python script all end as exit 124 or 126 with their own stderr, not as
 * a throw. What does reach here is a /files EROFS, an ENOSPC from the /work
 * filesystem, and a throw from inside an engine - so the only population this
 * can suppress is the first, and only when that exact error is the one that
 * propagated AND its refusal is named in the notes. Both conditions matter: the
 * refusal cap can leave the fatal refusal unnamed, and suppressing this note on
 * top of that told the model nothing at all - exit 1, empty streams, and notes
 * about other files.
 */
export const describeExecutionFailure = (
  failure: string | null,
  refusals: PresignedRefusals,
): ReadonlyArray<string> => {
  if (failure === null) {
    return [];
  }
  // Event identity: the exact message this mount raised, not a path found
  // somewhere inside the message. A refusal can be recorded without anything
  // failing, so a recorded path proves nothing about what propagated.
  const raised = refusals.raisedWrite;
  const alreadyExplained = raised !== null
    && raised.message === failure
    && refusals.recorded.some(
      (refusal) => refusal.kind === "read_only" && refusal.path === raised.path,
    );

  return alreadyExplained
    ? []
    : [`the command did not run to completion: ${quoteUntrustedText(failure)}`];
};

/**
 * Everything this layer has to say about one command, in reading order.
 *
 * One note budget for all of it, ordered by what changes the reading of what
 * came before: a command that stopped early first, then a read that failed -
 * from either mount, and from either route into the read-only one - which
 * decides what the output above it may be concluded from, then what /work did
 * not save afterwards.
 *
 * Exported because a test that assembles this list itself cannot test it: an
 * earlier one re-implemented this and asserted a note list it had supplied,
 * which left a regression piping the command's own stderr into the channel
 * entirely green.
 */
export const describeSandboxNotes = (
  outcome: ExecOutcome,
  refusals: PresignedRefusals,
  workRefusals: WorkRefusals,
  workNotes: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...describeExecutionFailure(outcome.failure, refusals),
  // Both routes into the read-only mount are in here, and indistinguishable:
  // recordPythonWriteRefusals put the ones the mount could not see into the
  // mount before this was called.
  ...describeFileRefusals(refusals),
  ...describeWorkRefusals(workRefusals),
  ...workNotes,
];

/**
 * Assemble the response under one aggregate budget.
 *
 * Both streams and all three lists are charged to MAX_RESPONSE_CHARS together,
 * so no part of a command's result can take the budget from another and push
 * the response past Lambda's own payload limit. The lists are measured first,
 * which is what keeps a noisy command from crowding out a "was not saved" the
 * model has to see.
 *
 * This is also where the python engine's guest mount prefix leaves the streams,
 * before they are cut: a truncation marker must land at the position the model
 * actually sees.
 */
export const assembleBashResponse = (
  outcome: ExecOutcome,
  diff: WorkDiff,
  durationMs: number,
): ChatSandboxBashResponse => {
  const reported = reportDiffWithinBudget(diff);
  const listChars = JSON.stringify({
    writtenFiles: reported.writtenFiles,
    deletedPaths: reported.deletedPaths,
    notes: reported.notes,
  }).length;
  // stdout is measured first, so what is left of the shared budget goes to
  // stderr rather than the other way round. stdout is the channel carrying the
  // answer the user asked for - the rows, the sums, the extracted text - while
  // stderr is diagnostics about producing it, and this layer's own statements
  // are not in stderr at all any more. A noisy warning loop should not be what
  // cuts the data in half.
  const stdout = capStream(
    rewritePythonGuestPaths(outcome.stdout),
    "stdout",
    Math.min(MAX_STREAM_CHARS, MAX_RESPONSE_CHARS - listChars),
  );

  return {
    stdout,
    stderr: capStream(
      rewritePythonGuestPaths(outcome.stderr),
      "stderr",
      Math.min(MAX_STREAM_CHARS, MAX_RESPONSE_CHARS - listChars - stdout.length),
    ),
    exitCode: outcome.exitCode,
    durationMs,
    writtenFiles: reported.writtenFiles,
    deletedPaths: reported.deletedPaths,
    notes: reported.notes,
  };
};

/**
 * The read-only mount of this session's originals.
 *
 * Built by the caller rather than inside the shell below, because what it
 * refused has to be read back out of it after the command has finished.
 */
export const createFilesFs = (
  fileEntries: ReadonlyArray<ChatSandboxFile>,
  transfer: SandboxObjectTransfer,
): PresignedFs =>
  new PresignedFs(
    fileEntries.map((entry) => ({
      path: toMountRelativePath(entry.path, SANDBOX_FILES_DIR),
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      mtimeMs: entry.mtimeMs,
      getUrl: entry.getUrl,
    })),
    transfer,
    SANDBOX_FILES_REQUEST_MAX_BYTES,
  );

/**
 * The shell one command of one session runs in, over both mounts.
 *
 * Exported so a test drives the same interpreter, mounts and limits the Lambda
 * does: every recurrence of a stale seed so far was reachable from real shell
 * and invisible to a test that called the filesystem directly.
 *
 * No `env` is passed, and one would not narrow anything: 3.6.0 builds the shell
 * environment from its own synthetic map and spreads `options.env` into it, so a
 * command never sees this process's variables. Pinned by the host-environment
 * test in bashOperation.test.ts.
 */
export const createSandboxBash = (filesFs: PresignedFs, workFs: RecordingWorkFs): Bash =>
  new Bash({
    fs: new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        { mountPoint: SANDBOX_FILES_DIR, filesystem: filesFs },
        { mountPoint: SANDBOX_WORK_DIR, filesystem: workFs },
      ],
    }),
    cwd: SANDBOX_WORK_DIR,
    executionLimitProfile: "normal",
    executionLimits: SANDBOX_EXECUTION_LIMITS,
    // Stated rather than inherited: 3.6.0 already defaults to the same thing,
    // and both report level "full", but python is arbitrary code execution
    // through CPython Emscripten and this layer should not silently disappear
    // in a later version. What it blocked is a content read served by a custom
    // mount: `PresignedFs` implements `IFileSystem`, so its `readFileBuffer`
    // runs unwrapped inside `exec`, where the globals undici needs are patched
    // to throw. just-bash materializes its own lazy entries inside
    // `DefenseInDepthBox.runTrustedAsync`, so the /work seeds were trusted all
    // along and only /files broke; `readPresignedObject` now takes the same
    // wrapper, scoped to that read's `executionId`. Nothing here is relaxed
    // for guest code.
    defenseInDepth: { enabled: "auto" },
    python: true,
  });

export const runChatSandboxBash = async (
  request: ChatSandboxBashRequest,
  deadlineEpochMs: number,
): Promise<ChatSandboxBashResponse> => {
  const startedAt = Date.now();
  const transfer = createPresignedObjectTransfer(deadlineEpochMs);
  const fileEntries = request.files.filter((file) => file.path.startsWith(`${SANDBOX_FILES_DIR}/`));
  const workEntries = request.files.filter((file) => file.path.startsWith(`${SANDBOX_WORK_DIR}/`));
  const workFs = createWorkFs(workEntries, transfer);
  const baselineByPath = new Map(
    workEntries.map((entry): readonly [string, WorkBaselineEntry] => [
      toMountRelativePath(entry.path, SANDBOX_WORK_DIR),
      { sha256: entry.sha256, sizeBytes: entry.sizeBytes },
    ]),
  );

  const filesFs = createFilesFs(fileEntries, transfer);
  const outcome = await execCommand(createSandboxBash(filesFs, workFs), request.command);
  // Before the mount's refusals are read, and on the command's own stderr
  // before the response rewrites the guest paths out of it.
  recordPythonWriteRefusals(filesFs, outcome.stderr);
  const diff = await diffWorkFiles(workFs, baselineByPath, request.writeSlots, transfer);
  // Read after the diff, not before: a seed is only materialized when something
  // reads it, and for `cp` that is the diff itself.
  return assembleBashResponse(
    outcome,
    {
      ...diff,
      notes: describeSandboxNotes(
        outcome,
        filesFs.getRefusals(),
        workFs.getRefusals(),
        diff.notes,
      ),
    },
    Date.now() - startedAt,
  );
};
