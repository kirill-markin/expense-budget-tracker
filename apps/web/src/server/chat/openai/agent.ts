import { Agent, run } from "@openai/agents";
import { codeInterpreterTool } from "@openai/agents-openai";
import type {
  ChatMessage,
  ChatStreamEvent,
  ContentPart,
} from "@/server/chat/types";
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

const SYSTEM_INSTRUCTIONS = `You are a financial assistant for an expense tracker app.
You have access to the user's expense database via the query_database tool and a code interpreter for analysis.
When the user asks about their finances, write SQL queries to fetch the data.
Present results clearly with formatting. Use the code interpreter for calculations, charts, or file analysis.
Be concise and direct. If a query returns no data, say so clearly.`;

const mapUserPart = (part: ContentPart): UserContentPart => {
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

const extractText = (content: ReadonlyArray<ContentPart>): string =>
  content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");

const summarizeContent = (content: ReadonlyArray<ContentPart>): string => {
  const parts: Array<string> = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push(p.text);
    } else if (p.type === "image") {
      parts.push("[attached image]");
    } else if (p.type === "file") {
      parts.push(`[attached file: ${p.fileName}]`);
    }
  }
  return parts.join("\n");
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
      result.push({ role: "user", content: msg.content.map(mapUserPart) });
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
}>;

export async function* streamAgentResponse(
  params: StreamAgentParams,
): AsyncGenerator<ChatStreamEvent> {
  const agent = new Agent<AgentContext>({
    name: "Expense Assistant",
    instructions: SYSTEM_INSTRUCTIONS,
    model: params.model,
    tools: [pgQueryTool, codeInterpreterTool()],
  });

  const context: AgentContext = {
    userId: params.userId,
    workspaceId: params.workspaceId,
  };

  const input = buildInput(params.messages);

  const result = await run(agent, input as Parameters<typeof run>[1], {
    stream: true,
    context,
    maxTurns: 10,
  });

  let activeToolName: string | null = null;

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
        yield { type: "tool_call", name: activeToolName, status: "started" };
      } else if (event.name === "tool_output" && event.item.type === "tool_call_output_item") {
        yield { type: "tool_call", name: activeToolName ?? "tool", status: "completed" };
        activeToolName = null;
      }
    }
  }

  yield { type: "done" };
}
