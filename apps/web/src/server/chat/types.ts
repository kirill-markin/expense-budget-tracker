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

export type ImageContentPart = Readonly<{
  type: "image";
  mediaType: string;
  base64Data: string;
}>;

export type FileContentPart = Readonly<{
  type: "file";
  mediaType: string;
  base64Data: string;
  fileName: string;
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
  | ToolCallContentPart
  | ReasoningSummaryContentPart;

export type ChatMessage = Readonly<{
  role: ChatRole;
  content: ReadonlyArray<ContentPart>;
}>;

export type ChatStreamEvent =
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
