import Anthropic from "@anthropic-ai/sdk";
import { toFile } from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  FileContentPart,
} from "@/server/chat/types";
import {
  SYSTEM_INSTRUCTIONS,
  extractText,
  summarizeContent,
} from "@/server/chat/shared";
import { log } from "@/server/logger";
import { CODE_EXECUTION_TOOL, DB_TOOL, TOOL_NAME, executeTool } from "./tools";

type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const MAX_TOKENS = 8192;
const MAX_TURNS = 10;
const FILES_BETA = "files-api-2025-04-14" as const;

export type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
}>;

const isUploadableFile = (part: ContentPart): part is FileContentPart =>
  part.type === "file" && part.mediaType !== "application/pdf";

const uploadFiles = async (
  client: Anthropic,
  messages: ReadonlyArray<ChatMessage>,
): Promise<Map<string, string>> => {
  const fileIds = new Map<string, string>();

  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMsg) return fileIds;

  const uploadParts = lastUserMsg.content.filter(isUploadableFile);
  for (const part of uploadParts) {
    const buffer = Buffer.from(part.base64Data, "base64");
    const file = await toFile(buffer, part.fileName, { type: part.mediaType });
    const metadata = await client.beta.files.upload({
      file,
      betas: [FILES_BETA],
    });
    fileIds.set(part.fileName, metadata.id);
  }

  return fileIds;
};

const mapUserPart = (
  part: ContentPart,
  fileIds: Map<string, string>,
): BetaContentBlockParam => {
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
    case "file": {
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
      const fileId = fileIds.get(part.fileName);
      if (fileId) {
        return { type: "container_upload", file_id: fileId };
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
  }
};

const buildMessages = (
  messages: ReadonlyArray<ChatMessage>,
  fileIds: Map<string, string>,
): Array<BetaMessageParam> => {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: Array<BetaMessageParam> = [];
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
      result.push({
        role: "user",
        content: msg.content.map((p) => mapUserPart(p, fileIds)),
      });
    } else {
      result.push({ role: "user", content: summarizeContent(msg.content) });
    }
  }
  return result;
};

const CODE_EXECUTION_RESULT_TYPES = new Set([
  "code_execution_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
]);

const blockToParam = (block: BetaContentBlock): BetaContentBlockParam => {
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
  if (block.type === "server_tool_use") {
    return {
      type: "server_tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  if (block.type === "web_search_tool_result") {
    return block as unknown as BetaContentBlockParam;
  }
  if (CODE_EXECUTION_RESULT_TYPES.has(block.type)) {
    return block as unknown as BetaContentBlockParam;
  }
  return { type: "text", text: "" };
};

export async function* streamAgentResponse(
  params: StreamAgentParams,
): AsyncGenerator<ChatStreamEvent> {
  const client = new Anthropic();
  const requestStart = Date.now();
  const hasAttachments = params.messages.some((m) =>
    m.content.some((p) => p.type !== "text"),
  );
  log({ domain: "chat", action: "request", vendor: "anthropic", model: params.model, messageCount: params.messages.length, hasAttachments });

  try {
    const fileIds = await uploadFiles(client, params.messages);
    const messages = buildMessages(params.messages, fileIds);
    let containerId: string | undefined;
    let completedTurns = 0;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      log({ domain: "chat", action: "turn_start", vendor: "anthropic", turn });
      const stream = client.beta.messages.stream({
        model: params.model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_INSTRUCTIONS,
        messages,
        tools: [
          DB_TOOL,
          CODE_EXECUTION_TOOL,
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
          },
        ],
        betas: [FILES_BETA],
        container: containerId,
      });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            yield { type: "tool_call", name: event.content_block.name, status: "started" };
          }
          if (event.content_block.type === "server_tool_use") {
            yield { type: "tool_call", name: event.content_block.name, status: "started" };
          }
          if (event.content_block.type === "web_search_tool_result") {
            yield { type: "tool_call", name: "web_search", status: "completed" };
          }
        }

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "delta", text: event.delta.text };
        }
      }

      const finalMessage = await stream.finalMessage();
      containerId = finalMessage.container?.id ?? containerId;

      messages.push({
        role: "assistant",
        content: finalMessage.content.map(blockToParam),
      });

      for (const block of finalMessage.content) {
        if (CODE_EXECUTION_RESULT_TYPES.has(block.type)) {
          yield { type: "tool_call", name: "code_execution", status: "completed" };
        }
      }

      completedTurns = turn + 1;

      if (finalMessage.stop_reason !== "tool_use") {
        log({ domain: "chat", action: "response", vendor: "anthropic", turns: completedTurns, stopReason: finalMessage.stop_reason ?? "unknown", durationMs: Date.now() - requestStart });
        yield { type: "done" };
        return;
      }

      const toolResults: Array<Anthropic.Beta.Messages.BetaToolResultBlockParam> = [];
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          log({ domain: "chat", action: "tool_call", vendor: "anthropic", tool: block.name, status: "started" });
          const toolStart = Date.now();
          const result = await executeTool(
            block.id,
            block.name,
            block.input,
            params.userId,
            params.workspaceId,
          );
          const toolStatus = result.is_error ? "error" : "completed";
          log({ domain: "chat", action: "tool_call", vendor: "anthropic", tool: block.name, status: toolStatus, durationMs: Date.now() - toolStart });
          toolResults.push(result);
          yield { type: "tool_call", name: block.name, status: "completed" };
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    log({ domain: "chat", action: "response", vendor: "anthropic", turns: completedTurns, stopReason: "max_turns", durationMs: Date.now() - requestStart });
    yield { type: "done" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log({ domain: "chat", action: "error", vendor: "anthropic", error: errorMessage });
    yield { type: "error", message: errorMessage };
  }
}
