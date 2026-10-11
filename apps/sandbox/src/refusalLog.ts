/**
 * The bounded, deduplicated record of what a mount refused during one command.
 *
 * Both mounts need one and they must behave identically: the shell cannot carry
 * a refusal to the model, so this is the only channel that can say a file exists
 * and could not be read. A model told a file is absent concludes the data is
 * absent and answers from what is left, so a second copy of these bounds that
 * drifted - a different cap, a different dedup key, a silent drop instead of a
 * reported count - would reintroduce exactly the silent omission the channel
 * exists to end, on whichever mount got the weaker copy. One implementation
 * makes that divergence impossible to write.
 */

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

/** One refusal, as a fact; the response layer renders it for the model. */
export type RefusalRecord<TKind extends string> = Readonly<{
  /** Path inside the mount, which the caller turns into a chat path. */
  path: string;
  kind: TKind;
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
export type RecordedRefusals<TKind extends string> = Readonly<{
  recorded: ReadonlyArray<RefusalRecord<TKind>>;
  /** Distinct refusals past the bound, which have no note of their own. */
  suppressedCount: number;
}>;

/**
 * One mount's refusals for one command.
 *
 * A closure over a Map and a counter rather than a class: nothing here has
 * inheritance, identity semantics or an external resource to hold, which is
 * what the two filesystems have and what earns them their classes. What it has
 * to be is the only implementation of these bounds, and a frozen record of two
 * functions is that just as well.
 *
 * Never cleared, because one mount serves one command: bashOperation.ts builds
 * both mounts per invocation and drops them with the response. A caller that
 * ever caches a mount across commands has to reset this too, or it would answer
 * for the wrong command.
 */
export type RefusalLog<TKind extends string> = Readonly<{
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
   * map is allocated once per mount, not once per read.
   */
  record: (path: string, kind: TKind, detail: string) => void;
  /** Every distinct refusal so far, in the order they happened. */
  getRecorded: () => RecordedRefusals<TKind>;
}>;

export const createRefusalLog = <TKind extends string>(): RefusalLog<TKind> => {
  /** Distinct refusals so far, keyed by kind and path so a loop adds one. */
  const refusals = new Map<string, RefusalRecord<TKind>>();
  /** Distinct refusals the bound left unnamed, reported as a count. */
  let suppressedCount = 0;

  return Object.freeze({
    record: (path: string, kind: TKind, detail: string): void => {
      const key = `${kind}:${path}`;
      if (refusals.size >= MAX_REFUSALS && !refusals.has(key)) {
        // Counted, not dropped: the response says how many more there were, so
        // the bound costs the model detail rather than the fact that it is
        // missing something. The earliest refusals are the ones kept, because
        // they are the ones the command acted on first.
        suppressedCount += 1;
        return;
      }

      // One line, because each note is one entry of the response's note list,
      // and the quoted failure is whatever an error message happened to contain.
      const quoted = detail.replace(/\s+/g, " ").trim();
      refusals.set(key, {
        path,
        kind,
        detail: quoted.length <= MAX_REFUSAL_DETAIL_CHARS
          ? quoted
          : `${quoted.slice(0, MAX_REFUSAL_DETAIL_CHARS)}[truncated]`,
      });
    },
    getRecorded: (): RecordedRefusals<TKind> => ({
      recorded: [...refusals.values()],
      suppressedCount,
    }),
  });
};
