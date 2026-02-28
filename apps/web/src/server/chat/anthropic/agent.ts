import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage, ChatStreamEvent } from "@/server/chat/types";
import {
  SYSTEM_INSTRUCTIONS,
  extractText,
  summarizeContent,
} from "@/server/chat/shared";
import {
  createDbMcpServer,
  QUALIFIED_TOOL_NAME,
  MCP_SERVER_NAME,
  MCP_TOOL_NAME,
} from "./tools";

export type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
}>;

const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

const stripMcpPrefix = (name: string): string =>
  name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;

const buildPromptText = (messages: ReadonlyArray<ChatMessage>): string => {
  const parts: Array<string> = [];
  for (const msg of messages) {
    const prefix = msg.role === "user" ? "User" : "Assistant";
    const text =
      msg.role === "assistant"
        ? extractText(msg.content)
        : summarizeContent(msg.content);
    parts.push(`${prefix}: ${text}`);
  }
  return parts.join("\n\n");
};

export async function* streamAgentResponse(
  params: StreamAgentParams,
): AsyncGenerator<ChatStreamEvent> {
  const mcpServer = createDbMcpServer(params.userId, params.workspaceId);

  const promptText = buildPromptText(params.messages);

  const abortController = new AbortController();

  const stream = query({
    prompt: promptText,
    options: {
      model: params.model,
      systemPrompt: SYSTEM_INSTRUCTIONS,
      mcpServers: { [MCP_SERVER_NAME]: mcpServer },
      allowedTools: [QUALIFIED_TOOL_NAME],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      maxTurns: 10,
      includePartialMessages: true,
      abortController,
    },
  });

  try {
    for await (const message of stream) {
      if (message.type === "stream_event") {
        const event = message.event;

        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "delta", text: event.delta.text };
        }

        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          yield {
            type: "tool_call",
            name: stripMcpPrefix(event.content_block.name),
            status: "started",
          };
        }
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            yield {
              type: "tool_call",
              name: stripMcpPrefix(block.name),
              status: "completed",
            };
          }
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          yield { type: "done" };
        } else {
          const errorText = message.errors?.join("; ") ?? "Unknown error";
          yield { type: "error", message: errorText };
        }
        return;
      }
    }

    yield { type: "done" };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    yield { type: "error", message: errorMessage };
  }
}
