import { Agent, run } from "@openai/agents";
import type { ModelResponse } from "@openai/agents-core";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import OpenAI from "openai";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
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
import { resolveServerManagedContainer } from "./containerState";
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
    code?: string;
    outputs?: unknown;
  }>;
}>;

type SpreadsheetContainerRef = Readonly<{
  containerId: string;
  responseId?: string;
  requestId?: string;
}>;

type QueryDatabaseToolOutput = Readonly<{
  statements?: ReadonlyArray<Readonly<{
    command?: unknown;
  }>>;
}>;

type StartAgentResponseResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
}>;

type OpenAIMessageOutputItem = Readonly<{
  type: "message";
  role?: string;
  content?: ReadonlyArray<Readonly<{
    type?: string;
    text?: string;
    annotations?: ReadonlyArray<Readonly<{
      filename?: string;
      path?: string;
      file_id?: string;
    }>>;
  }>>;
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

const CODE_INTERPRETER_CONTAINER_PREFIX = "expense-chat";
const CODE_INTERPRETER_CONTAINER_MINUTES = 20;
const MAX_LOG_SNIPPET_LENGTH = 400;

const buildOpenaiInstructions = (timezone: string, hasPersistentContainer: boolean): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter for calculations, charts, or file analysis. Use it when appropriate." +
  "\nIf the user attaches a CSV or spreadsheet file, inspect it with the code interpreter before claiming the file is unavailable." +
  (hasPersistentContainer
    ? "\nFiles previously attached earlier in this same chat remain available through code execution while the current code interpreter container is active."
    : "") +
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

const truncateForLog = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (value.length <= MAX_LOG_SNIPPET_LENGTH) {
    return value;
  }
  return value.slice(0, MAX_LOG_SNIPPET_LENGTH) + "...[truncated]";
};

export const shouldRefreshRouteAfterToolCall = (
  name: string,
  output: string,
): boolean => {
  if (name !== "query_database") {
    return false;
  }

  try {
    const parsed = JSON.parse(output) as QueryDatabaseToolOutput;
    if (!Array.isArray(parsed.statements)) {
      return false;
    }

    return parsed.statements.some((statement) =>
      typeof statement.command === "string" && statement.command.toUpperCase() !== "SELECT");
  } catch {
    return false;
  }
};

export const buildOpenAIContainerName = (requestId: string): string =>
  `${CODE_INTERPRETER_CONTAINER_PREFIX}-${requestId}`;

export const isOpenAIContainerExpired = (
  container: Awaited<ReturnType<OpenAI["containers"]["retrieve"]>>,
): boolean => {
  const minutes = container.expires_after?.minutes ?? CODE_INTERPRETER_CONTAINER_MINUTES;
  const anchorSeconds = container.last_active_at ?? container.created_at;
  return Date.now() >= (anchorSeconds + minutes * 60) * 1000;
};

const addFilesToOpenAIContainer = async (
  client: OpenAI,
  requestId: string,
  containerId: string,
  attachments: ReadonlyArray<FileContentPart>,
): Promise<void> => {
  for (const attachment of attachments) {
    const buffer = Buffer.from(attachment.base64Data, "base64");
    const file = new File([buffer], attachment.fileName, { type: attachment.mediaType });
    await client.containers.files.create(containerId, { file });
    log({
      domain: "chat",
      action: "code_interpreter_container_file_added",
      vendor: "openai",
      requestId,
      effectiveContainerId: containerId,
      attachmentFileName: attachment.fileName,
    });
  }
};

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
  requestId: string,
  effectiveContainerId: string | null,
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
      log({
        domain: "chat",
        action: "code_interpreter_container_inventory",
        vendor: "openai",
        requestId,
        effectiveContainerId: effectiveContainerId ?? container.containerId,
        attachmentFileNames: spreadsheetAttachmentFileNames,
        responseId: container.responseId,
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

const listOpenAIContainerInventory = async (
  client: OpenAI,
  requestId: string,
  containerId: string,
  attachmentFileNames: ReadonlyArray<string>,
): Promise<void> => {
  const files = await client.containers.files.list(containerId, { order: "asc" });
  log({
    domain: "chat",
    action: "code_interpreter_container_inventory",
    vendor: "openai",
    requestId,
    effectiveContainerId: containerId,
    attachmentFileNames,
    containerFilePaths: files.data.map((file) => file.path),
  });
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
  userId: string;
  workspaceId: string;
  timezone: string;
  requestId: string;
}>;

const getMessageOutputParts = (
  item: ModelResponse["output"][number],
): ReadonlyArray<NonNullable<OpenAIMessageOutputItem["content"]>[number]> => {
  if (item.type !== "message" || !("content" in item)) {
    return [];
  }
  const content = item.content;
  return Array.isArray(content)
    ? content as ReadonlyArray<NonNullable<OpenAIMessageOutputItem["content"]>[number]>
    : [];
};

export const summarizeOpenAIResponse = (
  responses: ReadonlyArray<ModelResponse>,
  finalOutput: string | undefined,
): Readonly<{
  finalOutputItemTypes: ReadonlyArray<string>;
  hasCodeInterpreterCall: boolean;
  codeInterpreterCallCount: number;
  codeSnippet: string | null;
  outputSummary: string | null;
  assistantTextSnippet: string | null;
  containerFileCitations: ReadonlyArray<string>;
}> => {
  const latestResponse = responses.at(-1);
  if (latestResponse === undefined) {
    return {
      finalOutputItemTypes: [],
      hasCodeInterpreterCall: false,
      codeInterpreterCallCount: 0,
      codeSnippet: null,
      outputSummary: null,
      assistantTextSnippet: truncateForLog(finalOutput),
      containerFileCitations: [],
    };
  }

  const finalOutputItemTypes = latestResponse.output.map((item) => item.type ?? "unknown");
  const codeInterpreterCalls = latestResponse.output.filter(isHostedCodeInterpreterOutput);
  const firstCodeInterpreterCall = codeInterpreterCalls[0];
  const outputSummary = firstCodeInterpreterCall === undefined
    ? null
    : truncateForLog(
      JSON.stringify(
        (firstCodeInterpreterCall.providerData as { outputs?: unknown } | undefined)?.outputs ?? null,
      ),
    );

  const messageTextParts = latestResponse.output
    .flatMap(getMessageOutputParts)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "");
  const containerFileCitations = latestResponse.output
    .flatMap(getMessageOutputParts)
    .flatMap((part) => part.annotations ?? [])
    .map((annotation) => annotation.path ?? annotation.filename ?? annotation.file_id ?? JSON.stringify(annotation));

  return {
    finalOutputItemTypes,
    hasCodeInterpreterCall: codeInterpreterCalls.length > 0,
    codeInterpreterCallCount: codeInterpreterCalls.length,
    codeSnippet: truncateForLog(firstCodeInterpreterCall?.providerData?.code),
    outputSummary,
    assistantTextSnippet: truncateForLog(finalOutput ?? messageTextParts.join("")),
    containerFileCitations,
  };
};

export const startAgentResponse = async (
  params: StreamAgentParams,
): Promise<StartAgentResponseResult> => {
  // Keep provider-specific orchestration isolated here so multi-provider support
  // can return later without reintroducing provider selection into the chat UI/API.
  const client = new OpenAI();
  const latestFileAttachments = getLatestUserFileAttachments(params.messages);
  const attachmentFileNames = latestFileAttachments.map((part) => part.fileName);
  const attachmentMediaTypes = latestFileAttachments.map((part) => part.mediaType);
  const spreadsheetAttachmentFileNames = getSpreadsheetAttachmentFileNames(latestFileAttachments);
  const effectiveContainerId = await resolveServerManagedContainer(
    client,
    params.requestId,
    params.userId,
    params.workspaceId,
    buildOpenAIContainerName,
    isOpenAIContainerExpired,
  );
  const forcedToolChoice = spreadsheetAttachmentFileNames.length > 0 ? "code_interpreter" : null;

  if (latestFileAttachments.length > 0) {
    await addFilesToOpenAIContainer(client, params.requestId, effectiveContainerId, latestFileAttachments);
    await listOpenAIContainerInventory(client, params.requestId, effectiveContainerId, attachmentFileNames);
  }

  const agent = new Agent<AgentContext>({
    name: "Expense Assistant",
    instructions: buildOpenaiInstructions(params.timezone, true),
    model: CHAT_MODEL_ID,
    modelSettings: forcedToolChoice === null ? {} : { toolChoice: forcedToolChoice },
    tools: [
      pgQueryTool,
      codeInterpreterTool({ container: effectiveContainerId }),
      webSearchTool({ searchContextSize: "medium" }),
    ],
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
    model: CHAT_MODEL_ID,
    requestId: params.requestId,
    messageCount: params.messages.length,
    hasAttachments,
    attachmentCount: latestFileAttachments.length,
    attachmentFileNames,
    attachmentMediaTypes,
    spreadsheetAttachmentFileNames,
    forcedToolChoice,
  });
  const requestStart = Date.now();

  const result = await run(agent, input as Parameters<typeof run>[1], {
    stream: true,
    context,
    maxTurns: 10,
  });

  const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
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
            const refreshRoute = shouldRefreshRouteAfterToolCall(name, toolOutput);
            yield {
              type: "tool_call",
              name,
              status: "completed",
              input: activeToolInput ?? undefined,
              output: toolOutput,
              refreshRoute,
            };
            activeToolName = null;
            activeToolInput = null;
          }
        }
      }

      if (spreadsheetAttachmentFileNames.length > 0) {
        await verifySpreadsheetContainers(client, params.requestId, effectiveContainerId, result.rawResponses, spreadsheetAttachmentFileNames);
      } else {
        await listOpenAIContainerInventory(client, params.requestId, effectiveContainerId, attachmentFileNames);
      }

      const responseSummary = summarizeOpenAIResponse(
        result.rawResponses,
        typeof result.finalOutput === "string" ? result.finalOutput : undefined,
      );
      log({
        domain: "chat",
        action: "response_summary",
        vendor: "openai",
        requestId: params.requestId,
        codeInterpreterContainerId: effectiveContainerId,
        finalOutputItemTypes: responseSummary.finalOutputItemTypes,
        hasCodeInterpreterCall: responseSummary.hasCodeInterpreterCall,
        codeInterpreterCallCount: responseSummary.codeInterpreterCallCount,
        codeSnippet: responseSummary.codeSnippet,
        outputSummary: responseSummary.outputSummary,
        assistantTextSnippet: responseSummary.assistantTextSnippet,
        containerFileCitations: responseSummary.containerFileCitations,
        stopReason: "done",
      });
      log({ domain: "chat", action: "response", vendor: "openai", turns: toolCalls, stopReason: "done", durationMs: Date.now() - requestStart });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log({ domain: "chat", action: "error", vendor: "openai", error: errorMessage });
      throw err;
    }

    yield { type: "done" };
  })();

  return {
    events,
  };
};
