import { Agent, run } from "@openai/agents";
import type { ModelResponse } from "@openai/agents-core";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import OpenAI from "openai";
import { CHAT_MODEL_ID, CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
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

type FunctionToolCallRawItem = Readonly<{
  type: "function_call";
  callId: string;
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
}>;

type HostedToolCallRawItem = Readonly<{
  type: "hosted_tool_call";
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
  output?: string;
  providerData?: Readonly<Record<string, unknown>>;
}>;

type ToolCallOutputRawItem = Readonly<{
  type: string;
  callId?: string;
  id?: string;
  name?: string;
}>;

type ToolCallEvent = Extract<ChatStreamEvent, { type: "tool_call" }>;

type ToolCallState = Readonly<{
  snapshot: ToolCallEvent;
  startedAt: number;
}>;

type OutputTextDeltaProviderData = Readonly<{
  type: "response.output_text.delta";
  item_id: string;
  content_index: number;
  output_index: number;
}>;

type OutputTextDoneEvent = Readonly<{
  type: "response.output_text.done";
  item_id: string;
  content_index: number;
  output_index: number;
  text: string;
}>;

type OutputItemDoneEvent = Readonly<{
  type: "response.output_item.done";
  output_index: number;
  item: Readonly<{
    id: string;
    type: string;
  }>;
}>;

type TextPartState = Readonly<{
  itemId: string;
  contentIndex: number;
  outputIndex: number;
  assembledText: string;
  doneText: string | null;
  isDone: boolean;
}>;

type TextStreamState = ReadonlyMap<string, TextPartState>;

type TextStreamUpdate = Readonly<{
  textStates: TextStreamState;
  emittedDelta: string | null;
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
const TERMINAL_TOOL_PROVIDER_STATUSES = new Set(["completed", "failed", "incomplete"]);

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

const formatTextMismatchError = (
  itemId: string,
  contentIndex: number,
  outputIndex: number,
  assembledText: string,
  doneText: string,
): string =>
  `OpenAI output_text.done mismatch for item_id=${itemId} content_index=${String(contentIndex)} output_index=${String(outputIndex)} assembled_len=${String(assembledText.length)} done_len=${String(doneText.length)} assembled=${truncateForLog(assembledText) ?? ""} done=${truncateForLog(doneText) ?? ""}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getRequiredStringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  errorPrefix: string,
): string => {
  const candidate = value[key];
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  throw new Error(`${errorPrefix}: missing string field ${key}`);
};

const getRequiredNumberField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
  errorPrefix: string,
): number => {
  const candidate = value[key];
  if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  throw new Error(`${errorPrefix}: missing non-negative integer field ${key}`);
};

const parseOutputTextDeltaProviderData = (
  providerData: unknown,
): OutputTextDeltaProviderData => {
  if (!isRecord(providerData)) {
    throw new Error("OpenAI output_text_delta is missing providerData");
  }
  const errorPrefix = `OpenAI output_text_delta providerData is invalid: ${JSON.stringify(providerData)}`;
  const type = getRequiredStringField(providerData, "type", errorPrefix);
  if (type !== "response.output_text.delta") {
    throw new Error(`${errorPrefix}: unexpected type ${type}`);
  }

  return {
    type: "response.output_text.delta",
    item_id: getRequiredStringField(providerData, "item_id", errorPrefix),
    content_index: getRequiredNumberField(providerData, "content_index", errorPrefix),
    output_index: getRequiredNumberField(providerData, "output_index", errorPrefix),
  };
};

const parseOutputTextDoneEvent = (
  rawEvent: unknown,
): OutputTextDoneEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_text.done") {
    return null;
  }
  const errorPrefix = `OpenAI response.output_text.done event is invalid: ${JSON.stringify(rawEvent)}`;
  return {
    type: "response.output_text.done",
    item_id: getRequiredStringField(rawEvent, "item_id", errorPrefix),
    content_index: getRequiredNumberField(rawEvent, "content_index", errorPrefix),
    output_index: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    text: getRequiredStringField(rawEvent, "text", errorPrefix),
  };
};

const parseOutputItemDoneEvent = (
  rawEvent: unknown,
): OutputItemDoneEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_item.done") {
    return null;
  }
  const errorPrefix = `OpenAI response.output_item.done event is invalid: ${JSON.stringify(rawEvent)}`;
  const rawItem = rawEvent.item;
  if (!isRecord(rawItem)) {
    throw new Error(`${errorPrefix}: missing item object`);
  }

  return {
    type: "response.output_item.done",
    output_index: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    item: {
      id: getRequiredStringField(rawItem, "id", errorPrefix),
      type: getRequiredStringField(rawItem, "type", errorPrefix),
    },
  };
};

const buildTextPartKey = (
  itemId: string,
  contentIndex: number,
): string =>
  `${itemId}:${String(contentIndex)}`;

const setTextPartState = (
  textStates: TextStreamState,
  nextState: TextPartState,
): TextStreamState => {
  const nextTextStates = new Map(textStates);
  nextTextStates.set(buildTextPartKey(nextState.itemId, nextState.contentIndex), nextState);
  return nextTextStates;
};

export const applyOutputTextDelta = (
  textStates: TextStreamState,
  providerData: OutputTextDeltaProviderData,
  delta: string,
): TextStreamUpdate => {
  const key = buildTextPartKey(providerData.item_id, providerData.content_index);
  const previousState = textStates.get(key);

  if (previousState !== undefined) {
    if (previousState.isDone) {
      throw new Error(
        `OpenAI output_text.delta arrived after output_text.done for item_id=${providerData.item_id} content_index=${String(providerData.content_index)} output_index=${String(providerData.output_index)}`,
      );
    }
    if (previousState.outputIndex !== providerData.output_index) {
      throw new Error(
        `OpenAI output_text.delta changed output_index for item_id=${providerData.item_id} content_index=${String(providerData.content_index)} from ${String(previousState.outputIndex)} to ${String(providerData.output_index)}`,
      );
    }
  }

  const nextState: TextPartState = {
    itemId: providerData.item_id,
    contentIndex: providerData.content_index,
    outputIndex: providerData.output_index,
    assembledText: (previousState?.assembledText ?? "") + delta,
    doneText: previousState?.doneText ?? null,
    isDone: false,
  };

  return {
    textStates: setTextPartState(textStates, nextState),
    emittedDelta: delta.length > 0 ? delta : null,
  };
};

export const applyOutputTextDone = (
  textStates: TextStreamState,
  doneEvent: OutputTextDoneEvent,
): TextStreamUpdate => {
  const key = buildTextPartKey(doneEvent.item_id, doneEvent.content_index);
  const previousState = textStates.get(key);
  const assembledText = previousState?.assembledText ?? "";

  if (previousState !== undefined && previousState.outputIndex !== doneEvent.output_index) {
    throw new Error(
      `OpenAI output_text.done changed output_index for item_id=${doneEvent.item_id} content_index=${String(doneEvent.content_index)} from ${String(previousState.outputIndex)} to ${String(doneEvent.output_index)}`,
    );
  }

  if (assembledText !== doneEvent.text) {
    throw new Error(
      formatTextMismatchError(
        doneEvent.item_id,
        doneEvent.content_index,
        doneEvent.output_index,
        assembledText,
        doneEvent.text,
      ),
    );
  }

  const nextState: TextPartState = {
    itemId: doneEvent.item_id,
    contentIndex: doneEvent.content_index,
    outputIndex: doneEvent.output_index,
    assembledText,
    doneText: doneEvent.text,
    isDone: true,
  };

  return {
    textStates: setTextPartState(textStates, nextState),
    emittedDelta: null,
  };
};

export const applyOutputItemDone = (
  textStates: TextStreamState,
  doneEvent: OutputItemDoneEvent,
): TextStreamUpdate => {
  if (doneEvent.item.type !== "message") {
    return {
      textStates,
      emittedDelta: null,
    };
  }

  for (const state of textStates.values()) {
    if (state.itemId !== doneEvent.item.id) {
      continue;
    }
    if (state.outputIndex !== doneEvent.output_index) {
      throw new Error(
        `OpenAI output_item.done changed output_index for item_id=${doneEvent.item.id} from ${String(state.outputIndex)} to ${String(doneEvent.output_index)}`,
      );
    }
    if (!state.isDone) {
      throw new Error(
        `OpenAI output_item.done arrived before output_text.done for item_id=${doneEvent.item.id} content_index=${String(state.contentIndex)} output_index=${String(doneEvent.output_index)}`,
      );
    }
  }

  return {
    textStates,
    emittedDelta: null,
  };
};

export const applyRawTextStreamEvent = (
  textStates: TextStreamState,
  event: Readonly<{
    type: string;
    delta?: string;
    providerData?: unknown;
    event?: unknown;
  }>,
): TextStreamUpdate => {
  if (event.type === "output_text_delta") {
    const providerData = parseOutputTextDeltaProviderData(event.providerData);
    if (typeof event.delta !== "string") {
      throw new Error(`OpenAI output_text_delta is missing delta for item_id=${providerData.item_id}`);
    }
    return applyOutputTextDelta(textStates, providerData, event.delta);
  }

  if (event.type === "model") {
    const doneEvent = parseOutputTextDoneEvent(event.event);
    if (doneEvent !== null) {
      return applyOutputTextDone(textStates, doneEvent);
    }

    const outputItemDoneEvent = parseOutputItemDoneEvent(event.event);
    if (outputItemDoneEvent !== null) {
      return applyOutputItemDone(textStates, outputItemDoneEvent);
    }
  }

  return {
    textStates,
    emittedDelta: null,
  };
};

const stringifyToolValue = (
  value: unknown,
): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
};

const isTerminalToolProviderStatus = (
  status: string | null | undefined,
): boolean =>
  status !== undefined
  && status !== null
  && TERMINAL_TOOL_PROVIDER_STATUSES.has(status);

const createToolCallEvent = (
  id: string,
  name: string,
  status: ToolCallEvent["status"],
  providerStatus: string | null,
  input: string | null,
  output: string | null,
  refreshRoute: boolean,
): ToolCallEvent => ({
  type: "tool_call",
  id,
  name,
  status,
  ...(providerStatus !== null ? { providerStatus } : {}),
  ...(input !== null ? { input } : {}),
  ...(output !== null ? { output } : {}),
  ...(refreshRoute ? { refreshRoute: true } : {}),
});

const getRequiredToolCallId = (
  rawItem: FunctionToolCallRawItem | HostedToolCallRawItem | ToolCallOutputRawItem,
): string => {
  if ("callId" in rawItem && typeof rawItem.callId === "string" && rawItem.callId.length > 0) {
    return rawItem.callId;
  }
  if (typeof rawItem.id === "string" && rawItem.id.length > 0) {
    return rawItem.id;
  }
  throw new Error(`OpenAI tool call is missing a stable identifier: ${JSON.stringify(rawItem)}`);
};

const getHostedToolCallInput = (
  rawItem: HostedToolCallRawItem,
): string | null => {
  if (typeof rawItem.arguments === "string") {
    return rawItem.arguments;
  }

  const providerData = rawItem.providerData;
  if (!isRecord(providerData)) {
    return null;
  }
  if (typeof providerData.code === "string") {
    return providerData.code;
  }
  if ("queries" in providerData) {
    return stringifyToolValue(providerData.queries);
  }
  if ("action" in providerData) {
    return stringifyToolValue(providerData.action);
  }

  return null;
};

const getHostedToolCallOutput = (
  rawItem: HostedToolCallRawItem,
): string | null => {
  if (typeof rawItem.output === "string") {
    return rawItem.output;
  }

  const providerData = rawItem.providerData;
  if (!isRecord(providerData)) {
    return null;
  }
  if ("outputs" in providerData) {
    return stringifyToolValue(providerData.outputs);
  }
  if ("results" in providerData) {
    return stringifyToolValue(providerData.results);
  }
  if ("result" in providerData) {
    return stringifyToolValue(providerData.result);
  }

  return null;
};

export const buildHostedToolCallEvent = (
  rawItem: HostedToolCallRawItem,
): ToolCallEvent => {
  const providerStatus = typeof rawItem.status === "string" ? rawItem.status : null;
  return createToolCallEvent(
    getRequiredToolCallId(rawItem),
    rawItem.name,
    isTerminalToolProviderStatus(providerStatus) ? "completed" : "started",
    providerStatus,
    getHostedToolCallInput(rawItem),
    getHostedToolCallOutput(rawItem),
    false,
  );
};

const buildFunctionToolCallEvent = (
  rawItem: FunctionToolCallRawItem,
): ToolCallEvent => {
  const providerStatus = typeof rawItem.status === "string" ? rawItem.status : null;
  return createToolCallEvent(
    getRequiredToolCallId(rawItem),
    rawItem.name,
    isTerminalToolProviderStatus(providerStatus) ? "completed" : "started",
    providerStatus,
    rawItem.arguments ?? null,
    null,
    false,
  );
};

const buildToolOutputEvent = (
  rawItem: ToolCallOutputRawItem,
  previousSnapshot: ToolCallEvent | null,
  rawOutput: unknown,
): ToolCallEvent => {
  const id = getRequiredToolCallId(rawItem);
  const output = stringifyToolValue(rawOutput);
  const name = previousSnapshot?.name ?? (typeof rawItem.name === "string" ? rawItem.name : "tool");
  const refreshRoute = output !== null && shouldRefreshRouteAfterToolCall(name, output);
  return createToolCallEvent(
    id,
    name,
    "completed",
    "completed",
    previousSnapshot?.input ?? null,
    output,
    refreshRoute,
  );
};

export const finalizeToolCallEvent = (
  event: ToolCallEvent,
): ToolCallEvent =>
  createToolCallEvent(
    event.id,
    event.name,
    "completed",
    isTerminalToolProviderStatus(event.providerStatus) ? (event.providerStatus ?? null) : "completed",
    event.input ?? null,
    event.output ?? null,
    event.refreshRoute === true,
  );

const areToolCallEventsEqual = (
  left: ToolCallEvent,
  right: ToolCallEvent,
): boolean =>
  left.id === right.id
  && left.name === right.name
  && left.status === right.status
  && left.providerStatus === right.providerStatus
  && left.input === right.input
  && left.output === right.output
  && left.refreshRoute === right.refreshRoute;

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
    modelSettings: {
      reasoning: { effort: CHAT_MODEL_REASONING_EFFORT },
      ...(forcedToolChoice === null ? {} : { toolChoice: forcedToolChoice }),
    },
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
    let toolCalls = 0;
    let textStates: TextStreamState = new Map();
    const toolStates = new Map<string, ToolCallState>();

    try {
      for await (const event of result) {
        if (event.type === "raw_model_stream_event") {
          const textUpdate = applyRawTextStreamEvent(textStates, event.data);
          textStates = textUpdate.textStates;
          if (textUpdate.emittedDelta !== null) {
            yield { type: "delta", text: textUpdate.emittedDelta };
          }
        } else if (event.type === "run_item_stream_event") {
          if (event.name === "tool_called" && event.item.type === "tool_call_item") {
            const snapshot = event.item.rawItem.type === "hosted_tool_call"
              ? buildHostedToolCallEvent(event.item.rawItem)
              : event.item.rawItem.type === "function_call"
                ? buildFunctionToolCallEvent(event.item.rawItem)
                : (() => {
                    throw new Error(`Unsupported OpenAI tool call type: ${event.item.rawItem.type}`);
                  })();
            const previousState = toolStates.get(snapshot.id);
            const startedAt = previousState?.startedAt ?? Date.now();
            toolStates.set(snapshot.id, { snapshot, startedAt });

            if (previousState === undefined && snapshot.status === "started") {
              log({ domain: "chat", action: "tool_call", vendor: "openai", tool: snapshot.name, status: "started" });
            }
            if (snapshot.status === "completed" && previousState?.snapshot.status !== "completed") {
              log({
                domain: "chat",
                action: "tool_call",
                vendor: "openai",
                tool: snapshot.name,
                status: "completed",
                durationMs: Date.now() - startedAt,
              });
              toolCalls++;
            }
            if (previousState === undefined || !areToolCallEventsEqual(previousState.snapshot, snapshot)) {
              yield snapshot;
            }
          } else if (event.name === "tool_output" && event.item.type === "tool_call_output_item") {
            const snapshotId = getRequiredToolCallId(event.item.rawItem);
            const previousState = toolStates.get(snapshotId);
            const snapshot = buildToolOutputEvent(
              event.item.rawItem,
              previousState?.snapshot ?? null,
              event.item.output,
            );
            const startedAt = previousState?.startedAt ?? Date.now();
            toolStates.set(snapshot.id, { snapshot, startedAt });

            if (previousState?.snapshot.status !== "completed") {
              log({
                domain: "chat",
                action: "tool_call",
                vendor: "openai",
                tool: snapshot.name,
                status: "completed",
                durationMs: Date.now() - startedAt,
              });
              toolCalls++;
            }
            if (previousState === undefined || !areToolCallEventsEqual(previousState.snapshot, snapshot)) {
              yield snapshot;
            }
          }
        }
      }

      for (const state of toolStates.values()) {
        if (state.snapshot.status === "completed") {
          continue;
        }

        const snapshot = finalizeToolCallEvent(state.snapshot);
        toolStates.set(snapshot.id, { snapshot, startedAt: state.startedAt });
        log({
          domain: "chat",
          action: "tool_call",
          vendor: "openai",
          tool: snapshot.name,
          status: "completed",
          durationMs: Date.now() - state.startedAt,
        });
        toolCalls++;
        yield snapshot;
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
