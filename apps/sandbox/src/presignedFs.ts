/**
 * Read-only filesystem over this session's pre-signed object URLs.
 *
 * Metadata comes from the request, so `ls -l`, `stat` and `find` answer without
 * touching object storage and the model can measure a file before deciding to
 * read it; only a command that actually reads content spends a download. Writes
 * are refused with EROFS, which is how `/files` stays the user's originals.
 *
 * A read is kept for the rest of the command, under the same aggregate ceiling
 * the request schema puts on this mount, so the cache cannot grow into an OOM
 * kill of the process serving the chat session.
 *
 * Every refusal is also recorded, because the shell cannot carry it: see
 * `recordRefusal`.
 */
import type { BufferEncoding, FileContent, FsStat, IFileSystem } from "just-bash";
import {
  classifyObjectReadFailure,
  requireDescribedObject,
  type ObjectReadFailure,
  type SandboxObjectTransfer,
} from "./objects.js";

// Structural copies of two option shapes just-bash does not re-export from its
// package root. Method parameters are compared structurally, so these keep the
// class assignable to IFileSystem without reaching into its dist layout.
type ReadFileOptionsLike = Readonly<{ encoding?: BufferEncoding | null }>;
type DirentEntryLike = Readonly<{
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}>;

const FILE_MODE = 0o444;
const DIRECTORY_MODE = 0o555;

/**
 * Why this mount refused something, separated by what the model should do next.
 *
 * The two of these that are not read failures: `read_only` is any mutator on
 * the user's originals, and `memory_limit` is the read cache's own ceiling.
 */
export type PresignedRefusalKind = ObjectReadFailure | "read_only" | "memory_limit";

/** One refusal, as a fact; the response layer renders it for the model. */
export type PresignedRefusal = Readonly<{
  /** Path inside this filesystem, which the caller turns into a chat path. */
  path: string;
  kind: PresignedRefusalKind;
  /** The underlying failure, already length-capped, or "" when there is none. */
  detail: string;
}>;

/**
 * What one command refused, and how much of it did not fit.
 *
 * The count is carried out with the refusals rather than dropped, because this
 * channel exists to end silent omission and a bound that silently omits would
 * reintroduce exactly that: a session with thirty attachments and one
 * URL-expiry event would name twenty files and leave the rest reaching the
 * model as nothing but the shell's hardcoded "No such file or directory".
 */
export type PresignedRefusals = Readonly<{
  recorded: ReadonlyArray<PresignedRefusal>;
  /** Distinct refusals past the bound, which have no note of their own. */
  suppressedCount: number;
  /**
   * The write refusal this mount raised most recently, and the exact message it
   * raised, or null when it has raised none.
   *
   * Carried so a caller can tell its own propagated error apart by event
   * identity rather than by looking for a path inside a message. Substring
   * matching was wrong in both directions: a refusal is plantable without any
   * failure at all - `chmod 777 /files` records one for the path `/`, after
   * which every message containing a slash looks explained - and a refusal
   * about `/files/d` matched a failure about `/work/data.csv`.
   *
   * Never cleared, because one mount serves one command: bashOperation.ts
   * builds it per invocation and drops it with the response. A caller that ever
   * caches a mount across commands has to reset this and `refusals` together -
   * either alone would answer for the wrong command.
   */
  raisedWrite: Readonly<{ path: string; message: string }> | null;
}>;

/**
 * Distinct refusals one command may name.
 *
 * Refusals are deduplicated by path and kind, so this bounds how many
 * different things went wrong, not how often: `for i in $(seq 1000); do cat
 * /files/x.csv; done` produces exactly one. Nothing caps how many files a chat
 * session holds - the web app bounds their bytes and their duplicate names,
 * not their number - so the bound is chosen for the response rather than
 * derived from the file set, and exceeding it is reported as its own note
 * instead of quietly dropping what this channel exists to say.
 */
const MAX_REFUSALS = 20;

/**
 * Characters of the underlying failure one refusal may quote.
 *
 * The widest detail is a digest mismatch, whose framing and two 64-character
 * hex digests cost 164 characters plus the path. The request schema puts no
 * length bound on a path, so no cap can promise the whole message for every
 * one of them; this one holds it whole for any name the web app can produce
 * (121 characters mount-relative, for 285 in total) and keeps MAX_REFUSALS
 * notes inside a few kilobytes of the response's note budget rather than
 * competing with the command's own output. When it does truncate, nothing the
 * model acts on is lost: the renderer puts the path first, outside the quoted
 * detail, and the refusal's kind - not its text - is what carries the next step.
 */
const MAX_REFUSAL_DETAIL_CHARS = 320;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type PresignedFileEntry = Readonly<{
  /** Path inside this filesystem, which is the chat path minus its mount point. */
  path: string;
  sizeBytes: number;
  sha256: string;
  mtimeMs: number;
  getUrl: string;
}>;

export const normalizeSandboxPath = (path: string): string => {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/** The directory holding a normalized absolute path; the root holds itself. */
export const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const decodeContent = (
  content: Uint8Array,
  options: ReadFileOptionsLike | BufferEncoding | undefined,
): string => {
  const encoding = typeof options === "string" ? options : options?.encoding;
  return Buffer.from(content).toString(encoding ?? "utf8");
};

/**
 * Every refusal leads with its errno, which is the only part of it just-bash
 * passes on.
 *
 * Measured against 3.6.0, with and without an `e.code` property on the same
 * error: `rm`, `mkdir`, `touch`, `cp`, `mv` and `ln` append the error's own
 * message, so the model reads "EROFS: read-only file system" and stops trying
 * to write; `chmod`, `sed -i`, `cat`, `head`, `wc` and `grep` print a fixed
 * "No such file or directory" for anything they catch, reading neither the
 * message nor the code. So the errno belongs in the message, where it is read,
 * and a `code` property would change nothing in either group.
 */
const readOnlyError = (operation: string, path: string): Error =>
  new Error(`EROFS: read-only file system, ${operation} '${path}'`);

const missingPathError = (operation: string, path: string): Error =>
  new Error(`ENOENT: no such file or directory, ${operation} '${path}'`);

export class PresignedFs implements IFileSystem {
  private readonly files: Map<string, PresignedFileEntry>;

  private readonly directories: Set<string>;

  private readonly contents: Map<string, Uint8Array>;

  private cachedBytes: number;

  private readonly maxCachedBytes: number;

  /** Distinct refusals so far, keyed by kind and path so a loop adds one. */
  private readonly refusals: Map<string, PresignedRefusal>;

  /** Distinct refusals the bound left unnamed, reported as a count. */
  private suppressedRefusals: number;

  /** The write refusal most recently raised from here, for event identity. */
  private raisedWrite: Readonly<{ path: string; message: string }> | null;

  private readonly transfer: SandboxObjectTransfer;

  public constructor(
    entries: ReadonlyArray<PresignedFileEntry>,
    transfer: SandboxObjectTransfer,
    maxCachedBytes: number,
  ) {
    this.transfer = transfer;
    this.maxCachedBytes = maxCachedBytes;
    this.files = new Map();
    this.directories = new Set(["/"]);
    this.contents = new Map();
    this.cachedBytes = 0;
    this.refusals = new Map();
    this.suppressedRefusals = 0;
    this.raisedWrite = null;
    for (const entry of entries) {
      const path = normalizeSandboxPath(entry.path);
      this.files.set(path, { ...entry, path });
      for (let parent = parentOf(path); parent !== "/"; parent = parentOf(parent)) {
        this.directories.add(parent);
      }
    }
  }

  /**
   * Record a refusal, because the shell will not carry it to the model.
   *
   * This is additive and must stay that way: the command still fails exactly as
   * it does now, with the shell's own message. It is needed because just-bash
   * 3.6.0 decides that message itself and `cat`, `head`, `wc`, `grep`, `sed`
   * and `chmod` all print a fixed "No such file or directory" for anything they
   * catch, reading neither the error's message nor an `e.code` - measured both
   * ways against 3.6.0. So a read that failed on an expired URL or a changed
   * object reaches the model as a file that does not exist, and a model told a
   * file is absent concludes the data is absent: it drops the file and presents
   * an incomplete answer over the user's finances as a complete one. The note
   * this records is the only channel that can carry the truth, so do not
   * "simplify" it away on the grounds that the shell already prints something.
   *
   * Nothing is recorded on a successful read, and this costs it nothing: the
   * map is allocated once per session, not once per read.
   */
  private recordRefusal(path: string, kind: PresignedRefusalKind, detail: string): void {
    const key = `${kind}:${path}`;
    if (this.refusals.size >= MAX_REFUSALS && !this.refusals.has(key)) {
      // Counted, not dropped: the response says how many more there were, so
      // the bound costs the model detail rather than the fact that it is
      // missing something. The earliest refusals are the ones kept, because
      // they are the ones the command acted on first.
      this.suppressedRefusals += 1;
      return;
    }

    // One line, because each note is one line of the response's stderr, and the
    // quoted failure is whatever an error message happened to contain.
    const quoted = detail.replace(/\s+/g, " ").trim();
    this.refusals.set(key, {
      path,
      kind,
      detail: quoted.length <= MAX_REFUSAL_DETAIL_CHARS
        ? quoted
        : `${quoted.slice(0, MAX_REFUSAL_DETAIL_CHARS)}[truncated]`,
    });
  }

  /** Every distinct refusal this command produced, in the order they happened. */
  public getRefusals(): PresignedRefusals {
    return {
      recorded: [...this.refusals.values()],
      suppressedCount: this.suppressedRefusals,
      raisedWrite: this.raisedWrite,
    };
  }

  /**
   * Refuse a write to the user's originals, and say so where the model can
   * read it: `rm` and `cp` print this error's own message, but `chmod` and
   * `sed -i` replace it with "No such file or directory".
   */
  private refuseWrite(operation: string, path: string): Error {
    const normalized = normalizeSandboxPath(path);
    this.recordRefusal(normalized, "read_only", "");
    const error = readOnlyError(operation, path);
    this.raisedWrite = { path: normalized, message: error.message };

    return error;
  }

  private requireFile(operation: string, path: string): PresignedFileEntry {
    const entry = this.files.get(normalizeSandboxPath(path));
    if (entry === undefined) {
      throw missingPathError(operation, path);
    }

    return entry;
  }

  public async readFileBuffer(path: string): Promise<Uint8Array> {
    const entry = this.requireFile("open", path);
    const cached = this.contents.get(entry.path);
    if (cached !== undefined) {
      return cached;
    }

    let content: Uint8Array;
    try {
      content = requireDescribedObject(
        entry.path,
        await this.transfer.readObject(entry.getUrl),
        entry,
      );
    } catch (error) {
      // Recorded and rethrown: the command fails the way it already does, and
      // the response carries why.
      this.recordRefusal(entry.path, classifyObjectReadFailure(error), describeError(error));
      throw error;
    }
    this.retain(entry.path, content);
    return content;
  }

  /**
   * Keep a downloaded original for the rest of the command, under an aggregate
   * ceiling.
   *
   * Reads are cached because a command that reads a file usually reads it
   * again, and a second download spends another pre-signed GET on bytes the
   * script was already handed. Nothing is evicted, so the cache needs a ceiling
   * of its own: unbounded, the mount grows until the kernel OOM-kills the
   * function, and because one process serves one chat session that kills the
   * session mid-command instead of answering with a tool error.
   *
   * The caller states the ceiling, the way RecordingWorkFs is given its own, so
   * the mount cannot hold more than its construction allowed whatever it was
   * handed. The sandbox passes the same number the request schema puts on
   * /files, so a validated request never reaches this error.
   */
  private retain(path: string, content: Uint8Array): void {
    if (this.cachedBytes + content.byteLength > this.maxCachedBytes) {
      const error = new Error(
        `ENOMEM: reads of this command already hold ${String(this.cachedBytes)} bytes of read-only originals in memory, and '${path}' would add ${String(content.byteLength)} more, past this mount's limit of ${String(this.maxCachedBytes)} bytes: read fewer originals in one command, or process them one at a time`,
      );
      this.recordRefusal(path, "memory_limit", error.message);
      throw error;
    }

    this.contents.set(path, content);
    this.cachedBytes += content.byteLength;
  }

  public async readFile(
    path: string,
    options?: ReadFileOptionsLike | BufferEncoding,
  ): Promise<string> {
    return decodeContent(await this.readFileBuffer(path), options);
  }

  public async exists(path: string): Promise<boolean> {
    const normalized = normalizeSandboxPath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  public async stat(path: string): Promise<FsStat> {
    const normalized = normalizeSandboxPath(path);
    const entry = this.files.get(normalized);
    if (entry !== undefined) {
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: FILE_MODE,
        size: entry.sizeBytes,
        mtime: new Date(entry.mtimeMs),
        identity: `presigned:${normalized}`,
      };
    }
    if (!this.directories.has(normalized)) {
      throw missingPathError("stat", path);
    }

    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: DIRECTORY_MODE,
      size: 0,
      mtime: new Date(0),
      identity: `presigned-dir:${normalized}`,
    };
  }

  public async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  public async readdirWithFileTypes(path: string): Promise<Array<DirentEntryLike>> {
    const normalized = normalizeSandboxPath(path);
    if (!this.directories.has(normalized)) {
      throw this.files.has(normalized)
        ? new Error(`ENOTDIR: not a directory, scandir '${path}'`)
        : missingPathError("scandir", path);
    }

    const entries: Array<DirentEntryLike> = [];
    for (const directory of this.directories) {
      if (directory !== "/" && parentOf(directory) === normalized) {
        entries.push({
          name: nameOf(directory),
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        });
      }
    }
    for (const file of this.files.keys()) {
      if (parentOf(file) === normalized) {
        entries.push({ name: nameOf(file), isFile: true, isDirectory: false, isSymbolicLink: false });
      }
    }

    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  public async readdir(path: string): Promise<Array<string>> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  public resolvePath(base: string, path: string): string {
    return path.startsWith("/")
      ? normalizeSandboxPath(path)
      : normalizeSandboxPath(`${base}/${path}`);
  }

  public getAllPaths(): Array<string> {
    return [...this.directories, ...this.files.keys()];
  }

  public async realpath(path: string): Promise<string> {
    const normalized = normalizeSandboxPath(path);
    if (!this.files.has(normalized) && !this.directories.has(normalized)) {
      throw missingPathError("realpath", path);
    }

    return normalized;
  }

  public async readlink(path: string): Promise<string> {
    throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
  }

  public async writeFile(path: string, _content: FileContent): Promise<void> {
    throw this.refuseWrite("open", path);
  }

  public async appendFile(path: string, _content: FileContent): Promise<void> {
    throw this.refuseWrite("open", path);
  }

  public async mkdir(path: string): Promise<void> {
    throw this.refuseWrite("mkdir", path);
  }

  public async createExclusive(path: string): Promise<void> {
    throw this.refuseWrite("open", path);
  }

  public async rm(path: string): Promise<void> {
    throw this.refuseWrite("unlink", path);
  }

  public async cp(_src: string, dest: string): Promise<void> {
    throw this.refuseWrite("copyfile", dest);
  }

  public async mv(_src: string, dest: string): Promise<void> {
    throw this.refuseWrite("rename", dest);
  }

  public async chmod(path: string): Promise<void> {
    throw this.refuseWrite("chmod", path);
  }

  public async symlink(_target: string, linkPath: string): Promise<void> {
    throw this.refuseWrite("symlink", linkPath);
  }

  public async link(_existingPath: string, newPath: string): Promise<void> {
    throw this.refuseWrite("link", newPath);
  }

  public async utimes(path: string): Promise<void> {
    throw this.refuseWrite("utimes", path);
  }
}
