import type { ChatMessage, ChatStreamEvent } from "@/server/chat/types";
import { CHAT_MODELS } from "@/lib/chatModels";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatRequestBody = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  timezone: string;
  chatSessionId: string;
  codeInterpreterContainerId: string | null;
}>;

type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
  timezone: string;
  chatSessionId: string;
  codeInterpreterContainerId: string | null;
}>;

type StartAgentResponseResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  responseHeaders?: Readonly<Record<string, string>>;
}>;

export type ChatRequestContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

type AgentModule = {
  startAgentResponse: (
    params: StreamAgentParams,
  ) => Promise<StartAgentResponseResult>;
};

const ENV_KEY_BY_VENDOR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const extractChatRequestContext = (request: Request): ChatRequestContext => ({
  userId: extractUserId(request),
  workspaceId: extractWorkspaceId(request),
});

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
  if (typeof candidate.chatSessionId !== "string" || candidate.chatSessionId.length === 0) {
    throw new Error("chatSessionId must be a non-empty string");
  }
  if (
    candidate.codeInterpreterContainerId !== null
    && candidate.codeInterpreterContainerId !== undefined
    && typeof candidate.codeInterpreterContainerId !== "string"
  ) {
    throw new Error("codeInterpreterContainerId must be a string or null");
  }

  return {
    messages: candidate.messages,
    model: candidate.model,
    timezone: candidate.timezone,
    chatSessionId: candidate.chatSessionId,
    codeInterpreterContainerId: candidate.codeInterpreterContainerId ?? null,
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

  const validModel = CHAT_MODELS.find((m) => m.id === body.model);
  if (validModel === undefined) {
    return new Response(`Unknown model: ${body.model}`, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("messages array is empty", { status: 400 });
  }

  const envKey = ENV_KEY_BY_VENDOR[validModel.vendor];
  if (envKey === undefined) {
    return new Response(`Unsupported vendor: ${validModel.vendor}`, { status: 400 });
  }

  const apiKey = process.env[envKey];
  if (apiKey === undefined || apiKey === "") {
    console.error("chat POST: %s environment variable is not set", envKey);
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
    console.error("chat POST: auth header extraction failed: %s", message);
    return new Response(message, { status: 401 });
  }

  const agentModule: AgentModule =
    validModel.vendor === "anthropic"
      ? await import("@/server/chat/anthropic/agent")
      : await import("@/server/chat/openai/agent");

  const started = await agentModule.startAgentResponse({
    model: body.model,
    messages: body.messages,
    userId,
    workspaceId,
    timezone: body.timezone,
    chatSessionId: body.chatSessionId,
    codeInterpreterContainerId: body.codeInterpreterContainerId,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of started.events) {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
          if (event.type === "done") break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("chat POST: stream error: %s", message);
        const errorLine = `data: ${JSON.stringify({ type: "error", message })}\n\n`;
        controller.enqueue(encoder.encode(errorLine));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(started.responseHeaders ?? {}),
    },
  });
};
