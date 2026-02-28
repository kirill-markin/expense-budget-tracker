import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
} from "@/server/chat/types";
import {
  SYSTEM_INSTRUCTIONS,
  extractText,
  summarizeContent,
} from "@/server/chat/shared";
import { DB_TOOL, TOOL_NAME, executeTool } from "./tools";

const MAX_TOKENS = 8192;
const MAX_TURNS = 10;

export type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
}>;

const mapUserPart = (
  part: ContentPart,
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam => {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: part.base64Data,
        },
      };
    case "file":
      if (part.mediaType === "application/pdf") {
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: part.base64Data,
          },
          title: part.fileName,
        };
      }
      return {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: Buffer.from(part.base64Data, "base64").toString("utf-8"),
        },
        title: part.fileName,
      };
  }
};

const buildMessages = (
  messages: ReadonlyArray<ChatMessage>,
): Array<Anthropic.MessageParam> => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: Array<Anthropic.MessageParam> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: [{ type: "text", text: extractText(msg.content) }],
      });
      continue;
    }

    const hasAttachments = msg.content.some((p) => p.type !== "text");

    if (!hasAttachments) {
      const text = extractText(msg.content);
      result.push({ role: "user", content: text });
      continue;
    }

    if (i === lastUserIdx) {
      result.push({ role: "user", content: msg.content.map(mapUserPart) });
    } else {
      result.push({ role: "user", content: summarizeContent(msg.content) });
    }
  }
  return result;
};

const blockToParam = (
  block: Anthropic.ContentBlock,
): Anthropic.ContentBlockParam => {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  return { type: "text", text: "" };
};

export async function* streamAgentResponse(
  params: StreamAgentParams,
): AsyncGenerator<ChatStreamEvent> {
  const client = new Anthropic();
  const messages = buildMessages(params.messages);

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.messages.stream({
        model: params.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_INSTRUCTIONS,
        messages,
        tools: [DB_TOOL],
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          yield { type: "tool_call", name: event.content_block.name, status: "started" };
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "delta", text: event.delta.text };
        }
      }

      const finalMessage = await stream.finalMessage();

      messages.push({
        role: "assistant",
        content: finalMessage.content.map(blockToParam),
      });

      if (finalMessage.stop_reason !== "tool_use") {
        yield { type: "done" };
        return;
      }

      const toolResults: Array<Anthropic.ToolResultBlockParam> = [];
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          const result = await executeTool(
            block.id,
            block.name,
            block.input,
            params.userId,
            params.workspaceId,
          );
          toolResults.push(result);
          yield { type: "tool_call", name: block.name, status: "completed" };
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    yield { type: "done" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: errorMessage };
  }
}
