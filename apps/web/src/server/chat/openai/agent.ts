import { Agent, run } from "@openai/agents";
import type { ModelResponse } from "@openai/agents-core";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import OpenAI from "openai";
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

type MessageOutputContentPart =
  | { type: "output_text"; text: string }
  | { type: "refusal"; refusal: string }
  | { type: "audio"; audio: string | { id: string }; format?: string | null; transcript?: string | null }
  | { type: "image"; image: string };

type HostedToolCallOutputItem = Readonly<{
  type: "hosted_tool_call";
  name: string;
  providerData?: Readonly<{
    type?: string;
    container_id?: string;
  }>;
}>;

type SpreadsheetContainerRef = Readonly<{
  containerId: string;
  responseId?: string;
  requestId?: string;
}>;

const SPREADSHEET_MEDIA_TYPES = new Set([
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SPREADSHEET_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
]);

const buildOpenaiInstructions = (timezone: string): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter for calculations, charts, or file analysis. Use it when appropriate." +
  "\nIf the user attaches a CSV or spreadsheet file, inspect it with the code interpreter before claiming the file is unavailable." +
  "\nYou also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information.";

const getLastUserMessage = (
  messages: ReadonlyArray<ChatMessage>,
): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i];
    }
  }
  return null;
};

export const getLatestUserFileAttachments = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<FileContentPart> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (lastUserMessage === null) {
    return [];
  }

  return lastUserMessage.content.filter((part): part is FileContentPart => part.type === "file");
};

const getFileExtension = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  return fileName.slice(lastDot).toLowerCase();
};

const isSpreadsheetAttachment = (part: FileContentPart): boolean =>
  SPREADSHEET_MEDIA_TYPES.has(part.mediaType) || SPREADSHEET_EXTENSIONS.has(getFileExtension(part.fileName));

export const getSpreadsheetAttachmentFileNames = (
  attachments: ReadonlyArray<FileContentPart>,
): ReadonlyArray<string> =>
  attachments.filter(isSpreadsheetAttachment).map((part) => part.fileName);

const isHostedCodeInterpreterOutput = (
  item: ModelResponse["output"][number],
): item is HostedToolCallOutputItem =>
  item.type === "hosted_tool_call" &&
  item.name === "code_interpreter_call";

export const extractCodeInterpreterContainers = (
  responses: ReadonlyArray<ModelResponse>,
): ReadonlyArray<SpreadsheetContainerRef> => {
  const containers = new Map<string, SpreadsheetContainerRef>();

  for (const response of responses) {
    for (const item of response.output) {
      if (!isHostedCodeInterpreterOutput(item)) {
        continue;
      }

      const containerId = item.providerData?.container_id;
      if (typeof containerId !== "string" || containerId.length === 0) {
        continue;
      }

      containers.set(containerId, {
        containerId,
        responseId: response.responseId,
        requestId: response.requestId,
      });
    }
  }

  return Array.from(containers.values());
};

const verifySpreadsheetContainers = async (
  client: OpenAI,
  responses: ReadonlyArray<ModelResponse>,
  spreadsheetAttachmentFileNames: ReadonlyArray<string>,
): Promise<void> => {
  const containers = extractCodeInterpreterContainers(responses);
  const latestResponse = responses.at(-1);

  if (containers.length === 0) {
    log({
      domain: "chat",
      action: "spreadsheet_container_missing_code_interpreter",
      vendor: "openai",
      attachmentFileNames: spreadsheetAttachmentFileNames,
      responseId: latestResponse?.responseId,
      requestId: latestResponse?.requestId,
    });
    return;
  }

  for (const container of containers) {
    try {
      const files = await client.containers.files.list(container.containerId, { order: "asc" });
      log({
        domain: "chat",
        action: "spreadsheet_container_verified",
        vendor: "openai",
        attachmentFileNames: spreadsheetAttachmentFileNames,
        responseId: container.responseId,
        requestId: container.requestId,
        containerId: container.containerId,
        containerFilePaths: files.data.map((file) => file.path),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log({
        domain: "chat",
        action: "spreadsheet_container_verification_failed",
        vendor: "openai",
        attachmentFileNames: spreadsheetAttachmentFileNames,
        responseId: container.responseId,
        requestId: container.requestId,
        containerId: container.containerId,
        error: errorMessage,
      });
    }
  }
};

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

const extractMessageOutputText = (
  item: { rawItem: { content: ReadonlyArray<MessageOutputContentPart> } },
): string =>
  item.rawItem.content.reduce(
    (text: string, part) => (part.type === "output_text" ? text + part.text : text),
    "",
  );

const getUnsentMessageOutputText = (
  fullText: string,
  streamedText: string,
): string => {
  if (streamedText.length === 0) {
    return fullText;
  }

  if (!fullText.startsWith(streamedText)) {
    throw new Error("OpenAI message output does not match streamed text prefix");
  }

  return fullText.slice(streamedText.length);
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
  const latestFileAttachments = getLatestUserFileAttachments(params.messages);
  const attachmentFileNames = latestFileAttachments.map((part) => part.fileName);
  const attachmentMediaTypes = latestFileAttachments.map((part) => part.mediaType);
  const spreadsheetAttachmentFileNames = getSpreadsheetAttachmentFileNames(latestFileAttachments);
  const forcedToolChoice = spreadsheetAttachmentFileNames.length > 0 ? "code_interpreter" : null;
  const agent = new Agent<AgentContext>({
    name: "Expense Assistant",
    instructions: buildOpenaiInstructions(params.timezone),
    model: params.model,
    modelSettings: forcedToolChoice === null ? {} : { toolChoice: forcedToolChoice },
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
  log({
    domain: "chat",
    action: "request",
    vendor: "openai",
    model: params.model,
    messageCount: params.messages.length,
    hasAttachments,
    attachmentFileNames,
    attachmentMediaTypes,
    spreadsheetAttachmentFileNames,
    forcedToolChoice,
  });
  const requestStart = Date.now();
  const verificationClient = spreadsheetAttachmentFileNames.length > 0 ? new OpenAI() : null;

  const result = await run(agent, input as Parameters<typeof run>[1], {
    stream: true,
    context,
    maxTurns: 10,
  });

  let activeToolName: string | null = null;
  let activeToolInput: string | null = null;
  let toolStart = 0;
  let toolCalls = 0;
  let streamedText = "";
  const emittedMessageOutputIds = new Set<string>();

  try {
    for await (const event of result) {
      if (event.type === "raw_model_stream_event") {
        if (event.data.type === "output_text_delta") {
          streamedText += event.data.delta;
          yield { type: "delta", text: event.data.delta };
        }
      } else if (event.type === "run_item_stream_event") {
        if (event.name === "message_output_created" && event.item.type === "message_output_item") {
          const messageId = event.item.rawItem.id;
          if (messageId !== undefined && emittedMessageOutputIds.has(messageId)) {
            continue;
          }

          const messageText = extractMessageOutputText(event.item);
          const unsentText = getUnsentMessageOutputText(messageText, streamedText);
          if (unsentText.length > 0) {
            streamedText += unsentText;
            yield { type: "delta", text: unsentText };
          }

          if (messageId !== undefined) {
            emittedMessageOutputIds.add(messageId);
          }
        } else if (event.name === "tool_called" && event.item.type === "tool_call_item") {
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
          const rawOutput = event.item.output;
          const toolOutput = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
          yield { type: "tool_call", name, status: "completed", input: activeToolInput ?? undefined, output: toolOutput };
          activeToolName = null;
          activeToolInput = null;
        }
      }
    }

    if (verificationClient !== null) {
      await verifySpreadsheetContainers(verificationClient, result.rawResponses, spreadsheetAttachmentFileNames);
    }

    log({ domain: "chat", action: "response", vendor: "openai", turns: toolCalls, stopReason: "done", durationMs: Date.now() - requestStart });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log({ domain: "chat", action: "error", vendor: "openai", error: errorMessage });
    throw err;
  }

  yield { type: "done" };
}
