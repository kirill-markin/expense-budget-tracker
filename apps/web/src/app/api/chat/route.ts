import { streamAgentResponse } from "@/server/chat/openai/agent";
import type { ChatMessage } from "@/server/chat/types";
import { CHAT_MODELS } from "@/lib/chatModels";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type ChatRequestBody = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
}>;

export const POST = async (request: Request): Promise<Response> => {
  const body: ChatRequestBody = await request.json();

  const validModel = CHAT_MODELS.find((m) => m.id === body.model);
  if (validModel === undefined) {
    return new Response(`Unknown model: ${body.model}`, { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response("messages array is empty", { status: 400 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey === undefined || openaiKey === "") {
    console.error("chat POST: OPENAI_API_KEY environment variable is not set");
    return new Response("OPENAI_API_KEY environment variable is not set", { status: 500 });
  }

  let userId: string;
  let workspaceId: string;
  try {
    userId = extractUserId(request);
    workspaceId = extractWorkspaceId(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("chat POST: auth header extraction failed: %s", message);
    return new Response(message, { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamAgentResponse({
          model: body.model,
          messages: body.messages,
          userId,
          workspaceId,
        })) {
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
