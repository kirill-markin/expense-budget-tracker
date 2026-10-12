export type ChatRole = "user" | "assistant";

export type StreamPosition = Readonly<{
  itemId: string;
  responseIndex?: number;
  outputIndex: number;
  contentIndex: number | null;
  sequenceNumber: number | null;
}>;

export type TextContentPart = Readonly<{
  type: "text";
  text: string;
  streamPosition?: StreamPosition;
}>;

/**
 * An image of the chat session, by reference. The bytes are never in a message:
 * the input reads the stored object and renders the data URL again on every turn
 * the image is resident in, while the per-turn manifest names it at `path` and
 * `view_file` shows it there once it is not.
 *
 * A pre-signed URL would be the cheaper send and may not be used: the prompt
 * cache matches on a byte-identical rendered prefix, and a signature that
 * changes every turn would cost the whole prompt behind it.
 */
export type ImageContentPart = Readonly<{
  type: "image";
  fileId: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
}>;

/**
 * An image still carrying its own bytes: what the browser sends until pre-signed
 * uploads replace that send, and what a payload written before the reference
 * above still holds.
 *
 * `chatFiles/ingest.ts` is the only place that turns one into an
 * {@link ImageContentPart}. Nothing sends it to the model and nothing stores it
 * once converted.
 */
export type InlineImageContentPart = Readonly<{
  type: "image";
  mediaType: string;
  base64Data: string;
}>;

/**
 * A document of the chat session, by reference. The bytes are never in a
 * message: the file is mounted in the sandbox at `path` and the model reads it
 * with `bash`, while the per-turn manifest names it.
 *
 * `sha256` and `sizeBytes` are the stored row's, so a part identifies one set
 * of bytes rather than one path: a later file written to the same path is a
 * different `fileId`.
 */
export type FileContentPart = Readonly<{
  type: "file";
  fileId: string;
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}>;

/**
 * A document still carrying its own bytes: what the browser sends until
 * pre-signed uploads replace that send, and what a payload written before the
 * reference above still holds.
 *
 * `chatFiles/ingest.ts` is the only place that turns one into a
 * {@link FileContentPart}. Nothing sends it to the model and nothing stores it
 * once converted.
 */
export type InlineFileContentPart = Readonly<{
  type: "file";
  mediaType: string;
  base64Data: string;
  fileName: string;
}>;

export type PdfPageContent = Readonly<{
  pageNumber: number;
  text: string;
  jpegBase64Data: string;
}>;

export type PdfContentPart = Readonly<{
  type: "pdf";
  fileName: string;
  mediaType: "application/pdf";
  sourceSha256: string;
  pages: ReadonlyArray<PdfPageContent>;
}>;

export type ToolCallContentPart = Readonly<{
  type: "tool_call";
  id?: string;
  name: string;
  status: "started" | "completed";
  providerStatus?: string | null;
  input: string | null;
  output: string | null;
  streamPosition?: StreamPosition;
}>;

export type ReasoningSummaryContentPart = Readonly<{
  type: "reasoning_summary";
  summary: string;
  streamPosition: StreamPosition;
}>;

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | FileContentPart
  | PdfContentPart
  | ToolCallContentPart
  | ReasoningSummaryContentPart;

/**
 * A part as a client sends it and as a stored payload may still read: every
 * part of {@link ContentPart}, plus the inline attachment shapes that the turn
 * prologue converts away.
 *
 * Only the request, store and browser-transcript boundaries use this. Model
 * input construction and history sizing take {@link ContentPart} alone, so a
 * document or an image reaches them as a reference or not at all.
 */
export type UnconvertedContentPart =
  | ContentPart
  | InlineFileContentPart
  | InlineImageContentPart;

/** Tells the two document shapes apart; only the inline one carries bytes. */
export const isInlineFileContentPart = (
  part: UnconvertedContentPart,
): part is InlineFileContentPart =>
  part.type === "file" && "base64Data" in part;

/** The same for the two image shapes. */
export const isInlineImageContentPart = (
  part: UnconvertedContentPart,
): part is InlineImageContentPart =>
  part.type === "image" && "base64Data" in part;

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: ReadonlyArray<ContentPart>;
}>;

/** One message whose attachments may not be files of the session yet. */
export type UnconvertedChatMessage = Readonly<{
  role: ChatRole;
  content: ReadonlyArray<UnconvertedContentPart>;
}>;

export type ChatStreamEvent =
  | Readonly<{
    type: "session";
    sessionId: string;
  }>
  | Readonly<{
    type: "delta";
    text: string;
    itemId: string;
    responseIndex?: number;
    outputIndex: number;
    contentIndex: number;
    sequenceNumber: number | null;
  }>
  | Readonly<{
    type: "tool_call";
    id: string;
    itemId: string;
    name: string;
    status: "started" | "completed";
    responseIndex?: number;
    outputIndex: number;
    sequenceNumber: number | null;
    providerStatus?: string;
    input?: string;
    output?: string;
    /**
     * Canonical session-level invalidation version attached by the chat runtime
     * after persisting a successful mutating database tool call.
     *
     * A tool call reaching transcript status `completed` is not enough on its
     * own to refresh route-backed content. The sidebar refreshes only when this
     * persisted version is present, which guarantees that the completed tool
     * both succeeded and mutated workspace data.
     *
     * Live SSE clients can refresh immediately from this event, while snapshot
     * polling later observes the same version from `/api/chat` and avoids
     * duplicate refreshes.
     */
    mainContentInvalidationVersion?: number;
    /**
     * Internal runtime hint indicating that this completed tool call is
     * eligible to persist main-content invalidation. It remains private to the
     * app-owned chat pipeline; the persisted invalidation version above is the
     * real refresh contract consumed by the browser.
     */
    refreshRoute?: boolean;
  }>
  | Readonly<{
    type: "reasoning_summary";
    itemId: string;
    responseIndex?: number;
    outputIndex: number;
    sequenceNumber: number | null;
    summary: string;
  }>
  | Readonly<{ type: "done" }>
  | Readonly<{ type: "error"; message: string }>;
