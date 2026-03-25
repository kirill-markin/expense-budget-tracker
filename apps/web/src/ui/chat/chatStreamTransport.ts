import type {
  ChatStreamEvent,
  ReasoningSummaryContentPart,
  StreamPosition,
  ToolCallContentPart,
} from "@/server/chat/types";

type ApplyMainContentInvalidationVersion = (
  nextVersion: number,
  source: "live",
) => void;

export type ChatStreamTransportHandlers = Readonly<{
  appendAssistantChunk: (text: string, streamPosition: StreamPosition) => void;
  upsertReasoningSummary: (reasoningSummary: ReasoningSummaryContentPart) => void;
  upsertToolCall: (toolCall: ToolCallContentPart) => void;
  markAssistantError: (errorText: string) => void;
  applyMainContentInvalidationVersion: ApplyMainContentInvalidationVersion;
}>;

export type ChatStreamTransportResult = Readonly<{
  receivedContent: boolean;
  reachedTerminalState: boolean;
}>;

export type DrainChatStreamChunkParams = Readonly<{
  buffer: string;
  chunk: string;
}>;

export type DrainChatStreamChunkResult = Readonly<{
  buffer: string;
  events: ReadonlyArray<ChatStreamEvent>;
}>;

const buildToolContentStreamPosition = (
  event: Extract<ChatStreamEvent, { type: "delta" | "reasoning_summary" | "tool_call" }>,
): StreamPosition => ({
  itemId: event.itemId,
  responseIndex: event.responseIndex,
  outputIndex: event.outputIndex,
  contentIndex: event.type === "delta" ? event.contentIndex : null,
  sequenceNumber: event.sequenceNumber,
});

export const parseChatStreamEventLine = (
  line: string,
): ChatStreamEvent | null => {
  if (!line.startsWith("data: ")) {
    return null;
  }

  try {
    return JSON.parse(line.slice(6)) as ChatStreamEvent;
  } catch {
    return null;
  }
};

export const drainChatStreamChunk = (
  params: DrainChatStreamChunkParams,
): DrainChatStreamChunkResult => {
  const lines = `${params.buffer}${params.chunk}`.split("\n");
  const nextBuffer = lines.pop() ?? "";
  const events: Array<ChatStreamEvent> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const event = parseChatStreamEventLine(trimmed);
    if (event !== null) {
      events.push(event);
    }
  }

  return {
    buffer: nextBuffer,
    events,
  };
};

export const applyChatStreamEvent = (
  event: ChatStreamEvent,
  handlers: ChatStreamTransportHandlers,
): ChatStreamTransportResult => {
  if (event.type === "delta") {
    handlers.appendAssistantChunk(event.text, buildToolContentStreamPosition(event));
    return {
      receivedContent: true,
      reachedTerminalState: false,
    };
  }

  if (event.type === "reasoning_summary") {
    handlers.upsertReasoningSummary({
      type: "reasoning_summary",
      summary: event.summary,
      streamPosition: buildToolContentStreamPosition(event),
    });
    return {
      receivedContent: true,
      reachedTerminalState: false,
    };
  }

  if (event.type === "tool_call") {
    handlers.upsertToolCall({
      type: "tool_call",
      id: event.id,
      name: event.name,
      status: event.status,
      providerStatus: event.providerStatus ?? null,
      input: event.input ?? null,
      output: event.output ?? null,
      streamPosition: buildToolContentStreamPosition(event),
    });

    // Transcript completion alone is not the refresh contract. The route
    // refreshes only when the completed tool event also carries the persisted
    // session invalidation version assigned by the runtime.
    if (event.status === "completed" && typeof event.mainContentInvalidationVersion === "number") {
      handlers.applyMainContentInvalidationVersion(
        event.mainContentInvalidationVersion,
        "live",
      );
    }

    return {
      receivedContent: true,
      reachedTerminalState: false,
    };
  }

  if (event.type === "error") {
    handlers.markAssistantError(event.message);
    return {
      receivedContent: false,
      reachedTerminalState: true,
    };
  }

  return {
    receivedContent: false,
    reachedTerminalState: true,
  };
};
