import OpenAI from "openai";

import type { ChatMessage } from "@/server/chat/types";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { handleRoute } from "@/server/api/handleRoute";
import { resetServerManagedContainer } from "@/server/chat/openai/containerState";
import { startAgentResponse } from "@/server/chat/openai/agent";
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

  const envKey = "OPENAI_API_KEY";
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

  const started = await startAgentResponse({
    messages: body.messages,
    userId,
    workspaceId,
    timezone: body.timezone,
    requestId: crypto.randomUUID(),
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
