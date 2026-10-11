/**
 * Loading the parsers, and telling a parser this build lacks from a document it
 * cannot read.
 *
 * Its own module because both document operations need it and neither owns it:
 * `prepare` loads pdf.js, mammoth, SheetJS and fflate, `pdf_page` loads pdf-lib,
 * and every one of them is reached through a dynamic import so that a `bash`
 * invocation - which is most of them - never parses megabytes it will not use.
 * The cost of that is this: a bundling defect surfaces at the first conversion
 * that needs the library rather than at start-up, in the middle of a `catch`
 * that was written for broken documents.
 */

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A conversion library this build cannot load, which is true of every source of
 * its format rather than of the one being converted.
 *
 * Measured against esbuild 0.28.2: a bundle emitted without the createRequire
 * banner of infra/aws/lib/chat-sandbox.ts fails `await import("mammoth")` with
 * `Dynamic require of "url" is not supported`, while the same bundle with the
 * banner loads mammoth and refuses a corrupt package with `Corrupted zip: can't
 * find end of central directory`. Under one `catch` neither carries anything to
 * tell it by: both are bare `Error`s with no class, no code and no field the
 * other lacks, so the only discriminator would be the message text - which is
 * the fragile identity test this repository has rejected elsewhere. Hence the
 * class: it is created where the loading happens, which is the one place that
 * knows which of the two it is looking at.
 *
 * The two must not be answered alike. The second is a fact about one upload,
 * and the first would mark every DOCX this deployment ever sees permanently
 * unconvertible.
 */
export class ConversionLibraryError extends Error {
  public constructor(library: string, cause: unknown) {
    super(
      `the chat sandbox could not load the '${library}' library its conversions need, which is a defect of this build rather than a property of any source: ${describeError(cause)}`,
      { cause },
    );
    this.name = "ConversionLibraryError";
  }
}

/**
 * Load one conversion library, and say so when that is what failed.
 *
 * The label is the whole value of this wrapper: the message a model never sees
 * but an operator does. It covers whatever the loader does, not merely the
 * `import` inside it, which is what lets a library with a runtime precondition -
 * pdf.js and its worker - put that precondition inside the same classification
 * instead of leaving it to fail later as a broken document.
 */
export const loadConversionLibrary = async <T>(
  library: string,
  load: () => Promise<T>,
): Promise<T> => {
  try {
    return await load();
  } catch (error) {
    throw new ConversionLibraryError(library, error);
  }
};
