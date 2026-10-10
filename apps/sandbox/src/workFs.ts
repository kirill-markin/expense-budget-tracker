/**
 * /work: this chat's writable scratch space, with a record of what one command
 * changed.
 *
 * Digesting every seeded file after a command would download and hash the whole
 * scratch space even for `echo hi`, and an untouched lazy entry is exactly what
 * must not be materialized. Recording the mutating calls leaves precisely the
 * paths worth hashing. Every writer routes through this IFileSystem, including
 * the python worker, and the internal copy and rename paths do not call the
 * public writers, so those record their destination as a prefix and the diff
 * hashes whatever appeared under it. A call that changes only mode or mtime
 * records nothing and updates the seed instead, because recording it would
 * download a file to prove its digest did not change. Removals are not
 * recorded: they are found by comparing the surviving tree with the baseline.
 */
import { InMemoryFs } from "just-bash";
import type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  FileContent,
  FsStat,
  MkdirOptions,
} from "just-bash";
import { parentOf } from "./presignedFs.js";

// just-bash does not re-export this option shape from its package root; method
// parameters are compared structurally, so a local copy keeps the overrides
// assignable.
type WriteFileOptionsLike = Readonly<{ encoding?: BufferEncoding }>;

/** What the request already states about a seeded /work file. */
export type SeededWorkFile = Readonly<{ sizeBytes: number; mtimeMs: number }>;

/** Mode InMemoryFs gives a file it creates, so a seeded entry reports the same. */
const SEEDED_FILE_MODE = 0o644;

/**
 * What a seeded entry currently reports: the request's own metadata, plus
 * whatever a metadata-only call has changed since. Mode and mtime live here
 * rather than in the base filesystem because reading them back from there
 * materializes the lazy entry, which is the download the seed exists to avoid.
 */
type SeedMetadata = Readonly<{ sizeBytes: number; mtimeMs: number; mode: number }>;

/** The final component of a normalized absolute path. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Join an already resolved directory with one entry name. */
const joinResolved = (directory: string, name: string): string =>
  directory === "/" ? `/${name}` : `${directory}/${name}`;

export class RecordingWorkFs extends InMemoryFs {
  private readonly mutatedPrefixes: Set<string>;

  private readonly seededFiles: Map<string, SeedMetadata>;

  public constructor(maxTotalBytes: number) {
    super(undefined, { maxTotalBytes });
    this.mutatedPrefixes = new Set();
    this.seededFiles = new Map();
  }

  /**
   * Mark a path the command wrote, at the key the base filesystem used for it.
   *
   * The invariant every override in this class keeps: record the seed at the
   * key the base class actually used. InMemoryFs is keyed by literal
   * normalized path, and in just-bash 3.6.0 its writers resolve no symlinks -
   * verified across the whole mutator set, where writeFile, writeFileSync,
   * appendFile, cp, mv, link, symlink, mkdir and chmod all key lexically - so a
   * lexical key is the correct one for every writer but two. `createExclusive`
   * resolves its PARENT and `utimes` resolves its TARGET, so those two key
   * resolved, the way `lstat` already does. A seed keyed anywhere else than the
   * base class keyed its entry keeps describing a file that is no longer there,
   * which is the one failure mode of this whole optimization.
   */
  private record(path: string): void {
    this.recordAt(this.resolvePath("/", path));
  }

  /**
   * Mark an already resolved key and drop the seed of every ancestor.
   *
   * InMemoryFs creates missing ancestor directories inside its own writers,
   * with no `mkdir` call, so writing `a.csv/part1` can turn a seeded `a.csv`
   * into a directory while `wasMutated` only ever sees the child. Every
   * mutation records its destination, so this is the one place that covers
   * that whole surface, and it drops rather than records, because recording a
   * directory prefix would make the diff download every seeded file beneath
   * it. Seeding writes its lazy entries without recording anything, so this
   * can never drop a seed one of its own siblings needed.
   */
  private recordAt(resolved: string): void {
    this.mutatedPrefixes.add(resolved);
    for (let ancestor = parentOf(resolved); ancestor !== "/"; ancestor = parentOf(ancestor)) {
      this.seededFiles.delete(ancestor);
    }
  }

  /**
   * Carry a metadata-only change into the seed instead of mutating the path.
   *
   * Neither mode nor mtime can change a digest, so recording such a call would
   * only make the path - or, for a directory, every seeded file under it - a
   * diff candidate that the diff downloads and hashes to prove nothing changed.
   * Measured over four seeded files: `chmod -R 755 /work` cost four downloads
   * and no upload, `chmod 755 /work/sub` three, `touch /work/sub` three, and
   * `chmod -R` and `touch` are both routine model-authored shell. Updating the
   * metadata the seed answers with keeps `stat` exact at no download at all.
   *
   * A key with no seed needs nothing: every other /work entry is either a
   * directory the base filesystem describes itself, or a file this command
   * created, which the writer that created it already recorded.
   */
  private updateSeed(key: string, change: Partial<SeedMetadata>): void {
    const seed = this.seededFiles.get(key);
    if (seed !== undefined) {
      this.seededFiles.set(key, { ...seed, ...change });
    }
  }

  /** True when the command wrote at, or anywhere under, this path. */
  public wasMutated(path: string): boolean {
    for (const prefix of this.mutatedPrefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Add one file the request described, as a lazy entry plus its metadata.
   *
   * The metadata is kept because `stat` must not fetch anything: InMemoryFs
   * materializes a lazy entry on `stat`, and MountableFs answers a directory
   * listing with one `stat` per entry, so without this an `ls -l` would
   * download the whole scratch space before the command does any work.
   *
   * The write goes through `super`, so seeding records nothing: a recording
   * writer here would drop the seed of any entry that is also this path's
   * ancestor instead of leaving that collision to the request schema.
   */
  public seedFile(
    path: string,
    metadata: SeededWorkFile,
    loadContent: () => Promise<Uint8Array>,
  ): void {
    super.writeFileLazy(path, loadContent, { mtime: new Date(metadata.mtimeMs) });
    this.seededFiles.set(
      this.resolvePath("/", path),
      { ...metadata, mode: SEEDED_FILE_MODE },
    );
  }

  /**
   * Metadata of the seeded entry at an existing, already resolved path.
   *
   * A mutated path may hold anything now, so it falls through to the base
   * filesystem. A merely materialized entry still matches: its loader verifies
   * the bytes against exactly this size and the mtime is carried over.
   */
  private describedSeed(resolvedPath: string): SeedMetadata | undefined {
    const seed = this.seededFiles.get(resolvedPath);
    return seed === undefined || this.wasMutated(resolvedPath) ? undefined : seed;
  }

  /**
   * The entry's own path, or undefined when nothing exists there.
   *
   * Both calls resolve symlinks without materializing anything, so a seeded
   * file reached through a symlink is answered from the same metadata, under
   * the same identity, as the file itself.
   */
  private async resolveExistingPath(path: string): Promise<string | undefined> {
    return (await super.exists(path)) ? super.realpath(path) : undefined;
  }

  /**
   * The identity is the resolved path rather than the base filesystem's own
   * token: the base mints one per entry object and only materializing an entry
   * reveals it, while two paths to one seeded entry resolve to one path.
   */
  private seedStat(seed: SeedMetadata, resolvedPath: string): FsStat {
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: seed.mode,
      size: seed.sizeBytes,
      mtime: new Date(seed.mtimeMs),
      identity: `work-seed:${resolvedPath}`,
    };
  }

  public override async stat(path: string): Promise<FsStat> {
    const resolved = await this.resolveExistingPath(path);
    if (resolved !== undefined) {
      const seed = this.describedSeed(resolved);
      if (seed !== undefined) {
        return this.seedStat(seed, resolved);
      }
    }

    return super.stat(path);
  }

  /**
   * The key the base class uses when it resolves a path's parent but leaves the
   * final component alone: intermediate symlinks followed, the name kept.
   *
   * This is `lstat`'s key, because lstat describes a final symlink itself
   * rather than its target, and it is also `createExclusive`'s, because that is
   * where the base class stores the entry it creates. `super.realpath` resolves
   * without materializing anything, which `super.lstat` would do for every
   * seeded entry reached through a symlinked directory. The caller must know
   * the parent exists; `super.realpath` raises otherwise.
   */
  private async resolvedParentKey(literal: string): Promise<string> {
    return joinResolved(await super.realpath(parentOf(literal)), nameOf(literal));
  }

  public override async lstat(path: string): Promise<FsStat> {
    const literal = this.resolvePath("/", path);
    const parent = parentOf(literal);
    if (parent !== literal && (await super.exists(parent))) {
      const linkPath = await this.resolvedParentKey(literal);
      if (await super.exists(linkPath)) {
        const seed = this.describedSeed(linkPath);
        if (seed !== undefined) {
          return this.seedStat(seed, linkPath);
        }
      }
    }

    return super.lstat(path);
  }

  /**
   * Drop the seed when a directory takes a seeded file's path directly.
   *
   * `rm a.csv && mkdir a.csv` leaves the entry existing with nothing recorded
   * under it, which is the one shape `record` does not see, and without this
   * the metadata would still describe the removed file and report a directory
   * as a file of the old size.
   */
  public override async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await super.mkdir(path, options);
    this.seededFiles.delete(this.resolvePath("/", path));
  }

  public override mkdirSync(path: string, options?: MkdirOptions): void {
    super.mkdirSync(path, options);
    this.seededFiles.delete(this.resolvePath("/", path));
  }

  public override async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptionsLike | BufferEncoding,
  ): Promise<void> {
    await super.writeFile(path, content, options);
    this.record(path);
  }

  public override writeFileSync(
    path: string,
    content: FileContent,
    options?: WriteFileOptionsLike | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    super.writeFileSync(path, content, options, metadata);
    this.record(path);
  }

  public override async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptionsLike | BufferEncoding,
  ): Promise<void> {
    await super.appendFile(path, content, options);
    this.record(path);
  }

  // The one writer whose parent the base class resolves, so the entry it
  // created is keyed there: `TMPDIR=/work/link mktemp` stores its file under
  // the symlink's target, not under the link. Recording the literal path
  // instead would leave a seeded file at the resolved key describing content
  // this call has just replaced. The parent exists, because
  // super.createExclusive raised otherwise.
  public override async createExclusive(
    path: string,
    options: CreateExclusiveOptions,
  ): Promise<void> {
    await super.createExclusive(path, options);
    this.recordAt(await this.resolvedParentKey(this.resolvePath("/", path)));
  }

  public override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await super.cp(src, dest, options);
    this.record(dest);
  }

  public override async mv(src: string, dest: string): Promise<void> {
    await super.mv(src, dest);
    this.record(dest);
  }

  // Hard links share one identity, which only the base filesystem mints, so the
  // source answers from there from now on. Linking already materialized it, so
  // giving up its seed downloads nothing.
  public override async link(existingPath: string, newPath: string): Promise<void> {
    await super.link(existingPath, newPath);
    this.seededFiles.delete(this.resolvePath("/", existingPath));
    this.record(newPath);
  }

  public override async symlink(target: string, linkPath: string): Promise<void> {
    await super.symlink(target, linkPath);
    this.record(linkPath);
  }

  // Mode and mtime cannot change a digest, so neither of these mutates the
  // path: they update the seed instead, which is what keeps `chmod -R` and
  // `touch` at zero downloads. chmod keys lexically, which is why the base
  // class reports ENOENT for a path under a symlinked directory rather than
  // resolving it.
  public override async chmod(path: string, mode: number): Promise<void> {
    await super.chmod(path, mode);
    this.updateSeed(this.resolvePath("/", path), { mode });
  }

  // The one call whose target the base class resolves, symlinks and all, so the
  // seed is keyed resolved. The path exists, because super.utimes raised
  // otherwise.
  public override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await super.utimes(path, atime, mtime);
    this.updateSeed(await super.realpath(path), { mtimeMs: mtime.getTime() });
  }
}
