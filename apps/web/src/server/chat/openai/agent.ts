import { Agent, run } from "@openai/agents";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
  TextContentPart,
  ImageContentPart,
  FileContentPart,
} from "@/server/chat/types";
import {
  buildSystemInstructions,
  extractText,
  summarizeContent,
} from "@/server/chat/shared";
import { log } from "@/server/logger";
import { pgQueryTool, type AgentContext } from "./tools";

// Agents SDK protocol format — NOT the Responses API wire format.
// The SDK reads `image` (not `image_url`) and `file` (not `file_data`).
type UserContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image: string }
  | { type: "input_file"; file: string; filename: string };

type AssistantContentPart = { type: "output_text"; text: string };

type InputMessage =
  | { role: "user"; content: string | ReadonlyArray<UserContentPart> }
  | { role: "assistant"; content: ReadonlyArray<AssistantContentPart> };

const buildOpenaiInstructions = (timezone: string): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter for calculations, charts, or file analysis. Use it when appropriate." +
  "\nYou also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information.";

const mapUserPart = (part: TextContentPart | ImageContentPart | FileContentPart): UserContentPart => {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image":
      return {
        type: "input_image",
        image: `data:${part.mediaType};base64,${part.base64Data}`,
      };
    case "file":
      return {
        type: "input_file",
        file: `data:${part.mediaType};base64,${part.base64Data}`,
        filename: part.fileName,
      };
  }
};

const buildInput = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<InputMessage> => {
  // Only include actual file data for the latest user message;
  // older attachments are summarized as text since the model already saw them.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const result: Array<InputMessage> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      result.push({
        role: "assistant",
        content: [{ type: "output_text", text: extractText(msg.content) }],
      });
      continue;
    }

    // User message
    const hasAttachments = msg.content.some((p) => p.type !== "text");

    if (!hasAttachments) {
      if (msg.content.length === 1 && msg.content[0].type === "text") {
        result.push({ role: "user", content: msg.content[0].text });
      } else {
        result.push({ role: "user", content: extractText(msg.content) });
      }
      continue;
    }

    if (i === lastUserIdx) {
      result.push({
        role: "user",
        content: msg.content
          .filter((p): p is TextContentPart | ImageContentPart | FileContentPart => p.type !== "tool_call")
          .map(mapUserPart),
      });
    } else {
      result.push({ role: "user", content: summarizeContent(msg.content) });
    }
  }
  return result;
};

export type StreamAgentParams = Readonly<{
  messages: ReadonlyArray<ChatMessage>;
  model: string;
  userId: string;
  workspaceId: string;
  timezone: string;
}>;

export async function* streamAgentResponse(
  params: StreamAgentParams,
): AsyncGenerator<ChatStreamEvent> {
  const agent = new Agent<AgentContext>({
    name: "Expense Assistant",
    instructions: buildOpenaiInstructions(params.timezone),
    model: params.model,
    tools: [pgQueryTool, codeInterpreterTool(), webSearchTool({ searchContextSize: "medium" })],
  });

  const context: AgentContext = {
    userId: params.userId,
    workspaceId: params.workspaceId,
  };

  const input = buildInput(params.messages);
  const hasAttachments = params.messages.some((m) =>
    m.content.some((p) => p.type !== "text"),
  );
  log({ domain: "chat", action: "request", vendor: "openai", model: params.model, messageCount: params.messages.length, hasAttachments });
  const requestStart = Date.now();

  const result = await run(agent, input as Parameters<typeof run>[1], {
    stream: true,
    context,
    maxTurns: 10,
  });

  let activeToolName: string | null = null;
  let activeToolInput: string | null = null;
  let toolStart = 0;
  let toolCalls = 0;

  try {
    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        if (event.data.type === "output_text_delta") {
          yield { type: "delta", text: event.data.delta };
        }
      } else if (event.type === "run_item_stream_event") {
        if (event.name === "tool_called" && event.item.type === "tool_call_item") {
          activeToolName = event.item.rawItem.type === "function_call"
            ? event.item.rawItem.name
            : event.item.rawItem.type;
          activeToolInput = event.item.rawItem.type === "function_call"
            ? (event.item.rawItem.arguments ?? null)
            : null;
          toolStart = Date.now();
          log({ domain: "chat", action: "tool_call", vendor: "openai", tool: activeToolName, status: "started" });
          yield { type: "tool_call", name: activeToolName, status: "started" };
        } else if (event.name === "tool_output" && event.item.type === "tool_call_output_item") {
          const name = activeToolName ?? "tool";
          log({ domain: "chat", action: "tool_call", vendor: "openai", tool: name, status: "completed", durationMs: Date.now() - toolStart });
          toolCalls++;
          yield { type: "tool_call", name, status: "completed", input: activeToolInput ?? undefined };
          activeToolName = null;
          activeToolInput = null;
        }
      }
    }

    log({ domain: "chat", action: "response", vendor: "openai", turns: toolCalls, stopReason: "done", durationMs: Date.now() - requestStart });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log({ domain: "chat", action: "error", vendor: "openai", error: errorMessage });
    throw err;
  }

  yield { type: "done" };
}
