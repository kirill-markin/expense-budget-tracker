/**
 * Chat file policy shared by the browser and the upload endpoint: the size
 * ceiling, the media types a declared file name may be stored under, and the
 * sandbox path a declared name is reduced to.
 */

export const CHAT_FILE_MAXIMUM_BYTES = 50 * 1024 * 1024;

/**
 * Where an attachment is mounted, which is SANDBOX_FILES_DIR in
 * apps/sandbox/src/contract.ts and must stay equal to it.
 *
 * Spelled out rather than imported, and the import is the tempting option now
 * that the server has a path to that module. Two things make it the wrong
 * trade, and both are narrower than "it would bloat the client": no browser
 * module imports this file today - every current importer is server code or a
 * test - so the concern is this file's stated purpose, which is to be the
 * policy the upload UI shares; and `apps/sandbox` declares no
 * `"sideEffects": false`, so a bundler asked to pull one string out of the
 * contract module cannot drop the zod request schema that comes with it. The
 * cost is latent rather than present, which is the kind that lands later.
 *
 * The equality is asserted instead, in server/chat/sandbox/invoke.test.ts,
 * where importing the contract is already free - so the two cannot drift in
 * either direction without failing CI.
 */
export const CHAT_FILE_SANDBOX_DIRECTORY = "/files";

// A browser reports this type whenever its own registry does not know an
// extension, so it is accepted for every name, and it is the only type an
// unlisted extension may be stored under: such a file stays an opaque binary
// with no derivative.
export const CHAT_FILE_OPAQUE_MEDIA_TYPE = "application/octet-stream";

// Media types accepted per extension. Several of these extensions carry more
// than one registered type and a browser reports whichever its own system
// registry holds, so each entry lists every type that still means the format.
const ACCEPTED_MEDIA_TYPES_BY_EXTENSION: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  [".jpg", ["image/jpeg"]],
  [".jpeg", ["image/jpeg"]],
  [".png", ["image/png"]],
  [".gif", ["image/gif"]],
  [".webp", ["image/webp"]],
  [".heic", ["image/heic", "image/heif"]],
  [".heif", ["image/heif", "image/heic"]],
  [".pdf", ["application/pdf"]],
  [".txt", ["text/plain"]],
  [".csv", ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"]],
  [".json", ["application/json", "text/json", "text/plain"]],
  [".xml", ["application/xml", "text/xml", "text/plain"]],
  [".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
  [".xls", ["application/vnd.ms-excel"]],
  [".md", ["text/markdown", "text/x-markdown", "text/plain"]],
  [".html", ["text/html", "text/plain"]],
  [".py", ["text/x-python", "text/x-python-script", "text/plain"]],
  [".js", ["text/javascript", "application/javascript", "text/plain"]],
  [".ts", ["text/typescript", "application/typescript", "video/mp2t", "text/plain"]],
  [".yaml", ["application/yaml", "text/yaml", "text/x-yaml", "text/plain"]],
  [".yml", ["application/yaml", "text/yaml", "text/x-yaml", "text/plain"]],
  [".sql", ["application/sql", "text/x-sql", "text/plain"]],
  [".log", ["text/plain"]],
  [".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
  [".zip", ["application/zip", "application/x-zip-compressed"]],
]);

export const CHAT_FILE_ACCEPTED_EXTENSIONS: ReadonlyArray<string> = Array.from(
  ACCEPTED_MEDIA_TYPES_BY_EXTENSION.keys(),
);

const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_+.-]*\/[a-z0-9][a-z0-9!#$&^_+.-]*$/;

// Control characters, path separators, and the characters a shell in the file
// sandbox would otherwise have to quote. Letters of any script survive, so a
// name written in another alphabet stays readable.
const UNSAFE_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f"'`$&;|<>*?!()[\]{}\\/:\s]+/g;

const MAXIMUM_FILE_NAME_STEM_LENGTH = 100;
const MAXIMUM_FILE_NAME_EXTENSION_LENGTH = 16;

/** Raised when a declared file name keeps no character a sandbox name can use. */
export class UnusableChatFileNameError extends Error {
  public constructor(fileName: string) {
    super(`fileName keeps no usable character for a sandbox file name: ${fileName}`);
    this.name = "UnusableChatFileNameError";
  }
}

/** Normalized media type, or null when the value is not a bare type/subtype. */
export const parseChatFileMediaType = (mediaType: string): string | null => {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  return MEDIA_TYPE_PATTERN.test(normalizedMediaType) ? normalizedMediaType : null;
};

const sanitizeFileNameSegment = (value: string): string =>
  value
    .replace(UNSAFE_FILE_NAME_CHARACTERS, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .replace(/[._-]+$/, "");

const splitSanitizedChatFileName = (
  fileName: string,
): Readonly<{ stem: string; extension: string }> => {
  const lastSeparatorIndex = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const baseName = fileName.slice(lastSeparatorIndex + 1);
  const lastDotIndex = baseName.lastIndexOf(".");
  // A leading dot belongs to the name itself, as it does on a POSIX file system.
  const hasExtension = lastDotIndex > 0;
  const stem = sanitizeFileNameSegment(
    hasExtension ? baseName.slice(0, lastDotIndex) : baseName,
  ).slice(0, MAXIMUM_FILE_NAME_STEM_LENGTH);
  if (stem === "") {
    throw new UnusableChatFileNameError(fileName);
  }

  const extensionBody = hasExtension
    ? sanitizeFileNameSegment(baseName.slice(lastDotIndex + 1).toLowerCase())
      .slice(0, MAXIMUM_FILE_NAME_EXTENSION_LENGTH)
    : "";
  return {
    stem,
    extension: extensionBody === "" ? "" : `.${extensionBody}`,
  };
};

/**
 * Media types a declared name may be stored under. The extension comes from
 * the same split that builds the sandbox path, so the accepted type and the
 * stored path can never read a different extension out of one name. Raises
 * UnusableChatFileNameError for a name that keeps no sandbox name at all.
 */
export const getAcceptedChatFileMediaTypes = (
  fileName: string,
): ReadonlyArray<string> => [
  ...(ACCEPTED_MEDIA_TYPES_BY_EXTENSION.get(
    splitSanitizedChatFileName(fileName).extension,
  ) ?? []),
  CHAT_FILE_OPAQUE_MEDIA_TYPE,
];

export const isAcceptedChatFileMediaType = (
  fileName: string,
  mediaType: string,
): boolean => getAcceptedChatFileMediaTypes(fileName).includes(mediaType);

/**
 * Extension a media type may be stored under, or null for a type no extension
 * accepts.
 *
 * The inverse of the table above, for the one attachment that declares a type
 * and no name at all: an inline image part. Read from the same table rather
 * than from a second list of its own, so a type accepted for an extension and
 * the extension chosen for that type can never disagree.
 */
export const getChatFileExtensionForMediaType = (
  mediaType: string,
): string | null => {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  for (const [extension, mediaTypes] of ACCEPTED_MEDIA_TYPES_BY_EXTENSION) {
    if (mediaTypes.includes(normalizedMediaType)) {
      return extension;
    }
  }

  return null;
};

export const sanitizeChatFileName = (fileName: string): string => {
  const { stem, extension } = splitSanitizedChatFileName(fileName);
  return `${stem}${extension}`;
};

/**
 * Duplicate indexes one declared name may take inside a session, which bounds
 * the search every writer of a row does for a free path.
 *
 * Sanitization folds distinct declared names onto the same sandbox name, so a
 * session can legitimately need a few suffixes. Exhausting them is a caller
 * outcome rather than an operator-facing failure.
 */
export const CHAT_FILE_MAXIMUM_PATH_DUPLICATES = 100;

/**
 * Sandbox path of a declared file name. A duplicate index above 1 appends the
 * suffix that keeps a name reused inside one session unique, before the
 * extension.
 */
export const buildChatFileSandboxPath = (
  fileName: string,
  duplicateIndex: number,
): string => {
  if (!Number.isInteger(duplicateIndex) || duplicateIndex < 1) {
    throw new Error(
      `Chat file duplicate index must be a whole number from 1, got ${String(duplicateIndex)}`,
    );
  }

  const { stem, extension } = splitSanitizedChatFileName(fileName);
  const duplicateSuffix = duplicateIndex === 1 ? "" : `-${String(duplicateIndex)}`;
  return `${CHAT_FILE_SANDBOX_DIRECTORY}/${stem}${duplicateSuffix}${extension}`;
};

/** File name a stored sandbox path stands for, used as the download name. */
export const getChatFileNameFromSandboxPath = (path: string): string => {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  if (fileName === "") {
    throw new Error(`Chat file path carries no file name: ${path}`);
  }

  return fileName;
};
