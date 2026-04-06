import type { ChatStreamEvent } from "@/server/chat/types";

export type ChatEventStreamParams = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  heartbeatIntervalMs: number;
  onStreamError: (error: string) => void;
}>;

export const CHAT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

const createSseDataLine = (event: ChatStreamEvent): string =>
  `data: ${JSON.stringify(event)}\n\n`;

const createSseHeartbeatLine = (): string =>
  ": keep-alive\n\n";

export const isExpectedStreamClosureError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Controller is already closed")
    || message.includes("ReadableStream is already closed")
    || message.includes("stream is already closed");
};

/**
 * Creates the SSE stream consumed by the sidebar and fullscreen chat clients.
 *
 * Live SSE is the low-latency path for deltas and tool-call completions, while
 * `/api/chat` snapshots remain the persisted recovery path. Both paths carry
 * the same session-level invalidation contract for refreshing route-backed main
 * content after successful mutating database tool calls.
 */
export const createChatEventStream = (params: ChatEventStreamParams): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let isClosed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  return new ReadableStream({
    async start(controller) {
      const closeStream = (): void => {
        clearHeartbeat();
        if (isClosed) {
          return;
        }
        isClosed = true;
        try {
          controller.close();
        } catch (error) {
          if (!isExpectedStreamClosureError(error)) {
            throw error;
          }
        }
      };

      const enqueueChunk = (chunk: string): boolean => {
        if (isClosed) {
          return false;
        }

        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch (error) {
          clearHeartbeat();
          isClosed = true;
          if (isExpectedStreamClosureError(error)) {
            return false;
          }
          throw error;
        }
      };

      const scheduleHeartbeat = (): void => {
        clearHeartbeat();
        if (isClosed) {
          return;
        }

        heartbeatTimer = setTimeout(() => {
          try {
            const written = enqueueChunk(createSseHeartbeatLine());
            if (!written) {
              return;
            }
            scheduleHeartbeat();
          } catch (error) {
            if (isClosed || isExpectedStreamClosureError(error)) {
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            params.onStreamError(message);
            closeStream();
          }
        }, params.heartbeatIntervalMs);
      };

      scheduleHeartbeat();

      try {
        for await (const event of params.events) {
          if (isClosed) {
            return;
          }
          clearHeartbeat();
          const written = enqueueChunk(createSseDataLine(event));
          if (!written) {
            return;
          }
          if (event.type === "done") {
            closeStream();
            return;
          }
          scheduleHeartbeat();
        }
      } catch (error) {
        clearHeartbeat();
        if (isClosed || isExpectedStreamClosureError(error)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        params.onStreamError(message);
        if (!isClosed) {
          const written = enqueueChunk(createSseDataLine({ type: "error", message }));
          if (!written) {
            return;
          }
        }
      }

      closeStream();
    },
    cancel() {
      clearHeartbeat();
      isClosed = true;
      const returnFn = params.events.return?.bind(params.events);
      if (returnFn === undefined) {
        return;
      }
      return returnFn(undefined).then(
        (): void => undefined,
        (): void => undefined,
      );
    },
  });
};
