import OpenAI from "openai";

import type { ChatMessage, ChatStreamEvent } from "@/server/chat/types";
import { CHAT_MODEL_ID, CHAT_VENDOR } from "@/lib/chatModels";
import { handleRoute } from "@/server/api/handleRoute";
import { resetServerManagedContainer } from "@/server/chat/openai/containerState";
import { startAgentResponse } from "@/server/chat/openai/agent";
import { log, type ChatErrorStage } from "@/server/logger";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatRequestBody = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  timezone: string;
}>;

export type ChatRequestContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

export type ChatRequestDiagnostics = Readonly<{
  requestId: string;
  model: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
  userId?: string;
  workspaceId?: string;
}>;

type ChatErrorLogEvent = Readonly<{
  domain: "chat";
  action: "error";
  vendor: typeof CHAT_VENDOR;
  stage: ChatErrorStage;
  error: string;
  requestId: string;
  userId?: string;
  workspaceId?: string;
  model: string;
  messageCount: number;
  hasAttachments: boolean;
  attachmentFileNames: ReadonlyArray<string>;
}>;

type ChatEventStreamParams = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  heartbeatIntervalMs: number;
  onStreamError: (error: string) => void;
}>;

export const CHAT_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export const extractChatRequestContext = (request: Request): ChatRequestContext => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
});

const collectChatAttachmentFileNames = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<string> => {
  const attachmentFileNames: Array<string> = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "file") {
        attachmentFileNames.push(part.fileName);
      }
    }
  }
  return attachmentFileNames;
};

export const buildChatRequestDiagnostics = (
  requestId: string,
  model: string,
  messages: ReadonlyArray<ChatMessage>,
  userId?: string,
  workspaceId?: string,
): ChatRequestDiagnostics => ({
  requestId,
  model,
  messageCount: messages.length,
  hasAttachments: messages.some((message) => message.content.some((part) => part.type !== "text")),
  attachmentFileNames: collectChatAttachmentFileNames(messages),
  userId,
  workspaceId,
});

export const createChatErrorLogEvent = (
  diagnostics: ChatRequestDiagnostics,
  stage: ChatErrorStage,
  error: string,
): ChatErrorLogEvent => ({
  domain: "chat",
  action: "error",
  vendor: CHAT_VENDOR,
  stage,
  error,
  requestId: diagnostics.requestId,
  userId: diagnostics.userId,
  workspaceId: diagnostics.workspaceId,
  model: diagnostics.model,
  messageCount: diagnostics.messageCount,
  hasAttachments: diagnostics.hasAttachments,
  attachmentFileNames: diagnostics.attachmentFileNames,
});

const createSseDataLine = (event: ChatStreamEvent): string =>
  `data: ${JSON.stringify(event)}\n\n`;

const createSseHeartbeatLine = (): string =>
  ": keep-alive\n\n";

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
        controller.close();
      };

      const enqueueChunk = (chunk: string): void => {
        if (isClosed) {
          throw new Error("Chat stream is already closed");
        }

        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          clearHeartbeat();
          isClosed = true;
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
            enqueueChunk(createSseHeartbeatLine());
            scheduleHeartbeat();
          } catch (error) {
            if (isClosed) {
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
          enqueueChunk(createSseDataLine(event));
          if (event.type === "done") {
            closeStream();
            return;
          }
          scheduleHeartbeat();
        }
      } catch (error) {
        clearHeartbeat();
        if (isClosed) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        params.onStreamError(message);
        if (!isClosed) {
          enqueueChunk(createSseDataLine({ type: "error", message }));
        }
      }

      closeStream();
    },
    cancel() {
      clearHeartbeat();
      isClosed = true;
      return;
    },
  });
};

export const parseChatRequestBody = (body: unknown): ChatRequestBody => {
  if (typeof body !== "object" || body === null) {
    throw new Error("Invalid chat request body");
  }

  const candidate = body as Partial<ChatRequestBody>;
  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) {
    throw new Error("messages array is empty");
  }
  if (typeof candidate.model !== "string" || candidate.model.length === 0) {
    throw new Error("model must be a non-empty string");
  }
  if (typeof candidate.timezone !== "string" || candidate.timezone.length === 0) {
    throw new Error("timezone must be a non-empty string");
  }

  return {
    messages: candidate.messages,
    model: candidate.model,
    timezone: candidate.timezone,
  };
};

export const POST = async (request: Request): Promise<Response> => {
  let body: ChatRequestBody;
  try {
    body = parseChatRequestBody(await request.json());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message === "Invalid chat request body" ? message : message, { status: 400 });
  }

  if (body.model !== CHAT_MODEL_ID) {
    return new Response(`Unsupported model: ${body.model}. Expected ${CHAT_MODEL_ID}`, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("messages array is empty", { status: 400 });
  }

  const requestId = crypto.randomUUID();
  const requestDiagnostics = buildChatRequestDiagnostics(requestId, body.model, body.messages);

  const envKey = "OPENAI_API_KEY";
  const apiKey = process.env[envKey];
  if (apiKey === undefined || apiKey === "") {
    log(createChatErrorLogEvent(requestDiagnostics, "config", `${envKey} environment variable is not set`));
    return new Response(`${envKey} environment variable is not set`, { status: 500 });
  }

  let userId: string;
  let workspaceId: string;
  try {
    const context = extractChatRequestContext(request);
    userId = context.userId;
    workspaceId = context.workspaceId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(createChatErrorLogEvent(requestDiagnostics, "auth", message));
    return new Response(message, { status: 401 });
  }

  const diagnostics = buildChatRequestDiagnostics(requestId, body.model, body.messages, userId, workspaceId);

  let started: Awaited<ReturnType<typeof startAgentResponse>>;
  try {
    started = await startAgentResponse({
      messages: body.messages,
      userId,
      workspaceId,
      timezone: body.timezone,
      requestId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(createChatErrorLogEvent(diagnostics, "agent", message));
    throw err;
  }

  const stream = createChatEventStream({
    events: started.events,
    heartbeatIntervalMs: CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
    onStreamError: (error: string): void => {
      log(createChatErrorLogEvent(diagnostics, "stream", error));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};

export const DELETE = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/chat", method: "DELETE", internalErrorMessage: "Chat reset failed" },
    async (): Promise<Response> => {
      const context = extractChatRequestContext(request);
      await resetServerManagedContainer(new OpenAI(), crypto.randomUUID(), context.userId, context.workspaceId);
      return Response.json({ ok: true });
    },
  );
