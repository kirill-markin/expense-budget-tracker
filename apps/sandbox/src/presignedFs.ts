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
 * RefusalLog in ./refusalLog.ts, which the /work mount shares.
 */
import type { BufferEncoding, FileContent, FsStat, IFileSystem } from "just-bash";
import {
  classifyObjectReadFailure,
  requireDescribedObject,
  type ObjectReadFailure,
  type SandboxObjectTransfer,
} from "./objects.js";
import {
  createRefusalLog,
  type RecordedRefusals,
  type RefusalLog,
  type RefusalRecord,
} from "./refusalLog.js";

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
export type PresignedRefusal = RefusalRecord<PresignedRefusalKind>;

/**
 * What one command refused on this mount, plus the write refusal it raised.
 *
 * The bounded, deduplicated record itself is RefusalLog, shared with the /work
 * mount so both channels cannot drift apart. Only `raisedWrite` is specific to
 * this mount, because only this one refuses writes.
 */
export type PresignedRefusals = RecordedRefusals<PresignedRefusalKind> & Readonly<{
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
   * caches a mount across commands has to reset this and the refusal log
   * together - either alone would answer for the wrong command.
   */
  raisedWrite: Readonly<{ path: string; message: string }> | null;
}>;

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

  /** Distinct refusals so far, bounded and deduplicated by the shared log. */
  private readonly refusals: RefusalLog<PresignedRefusalKind>;

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
    this.refusals = createRefusalLog();
    this.raisedWrite = null;
    for (const entry of entries) {
      const path = normalizeSandboxPath(entry.path);
      this.files.set(path, { ...entry, path });
      for (let parent = parentOf(path); parent !== "/"; parent = parentOf(parent)) {
        this.directories.add(parent);
      }
    }
  }

  /** Record a refusal through the shared log, which bounds and deduplicates it. */
  private recordRefusal(path: string, kind: PresignedRefusalKind, detail: string): void {
    this.refusals.record(path, kind, detail);
  }

  /**
   * Record a refusal of this mount that this mount never saw.
   *
   * There is exactly one such route, and it is not a hypothetical: just-bash's
   * python engine checks an entry's mode inside its own guest filesystem before
   * it bridges a write back here, and this mount reports 0444 files inside 0555
   * directories, so a python write to an original is refused without any method
   * below ever being called. The caller detects that shape and routes it here
   * rather than keeping a second log of its own, because the bound, the dedup
   * and the suppressed count have to count one command's refusals once however
   * they arrived - two logs meant two different "N further files were refused"
   * notes about one command.
   *
   * `raisedWrite` is deliberately not set: nothing propagated out of `exec` for
   * this refusal, and that field answers for what did.
   */
  public recordBypassedRefusal(
    path: string,
    kind: PresignedRefusalKind,
    detail: string,
  ): void {
    this.recordRefusal(normalizeSandboxPath(path), kind, detail);
  }

  /** Every distinct refusal this command produced, in the order they happened. */
  public getRefusals(): PresignedRefusals {
    return { ...this.refusals.getRecorded(), raisedWrite: this.raisedWrite };
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
