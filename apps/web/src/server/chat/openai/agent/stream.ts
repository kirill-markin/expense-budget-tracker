import { Agent, MaxTurnsExceededError, Runner } from "@openai/agents";
import type { AgentInputItem, ModelResponse } from "@openai/agents-core";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import OpenAI from "openai";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { persistChatSessionConversationId } from "@/server/chat/store";
import type { ChatMessage, ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
import { resolveServerManagedContainer } from "../containerState";
import { pgQueryTool, type AgentContext } from "../tools";
import { buildOpenAIModelSettings, buildOpenaiInstructions } from "./config";
import {
  addFilesToOpenAIContainer,
  buildOpenAIContainerName,
  containerHasAttachment,
  isOpenAIContainerExpired,
  listOpenAIContainerInventory,
  summarizeOpenAIResponse,
  verifySpreadsheetContainers,
} from "./containers";
import {
  buildInput,
  getAllUserFileAttachments,
  getLatestUserFileAttachments,
  getSpreadsheetAttachmentFileNames,
} from "./input";
import {
  createTextStreamState,
  type TextStreamState,
  applyRawTextStreamEvent,
} from "./textStream";
import {
  applyFunctionCallArgumentsDelta,
  applyFunctionCallArgumentsDone,
  applyToolCallOutput,
  applyToolCallStarted,
  createToolCallStateMap,
  finalizePendingToolCalls,
  type FunctionToolCallRawItem,
  type FunctionCallArgumentsDeltaEvent,
  type FunctionCallArgumentsDoneEvent,
  type HostedToolCallRawItem,
  getRequiredToolCallId,
  getTrackedToolCallPosition,
  type ToolCallPosition,
  type ToolCallOutputRawItem,
} from "./toolCalls";

/**
 * Parameters for one browser-chat turn executed against OpenAI-managed conversation state.
 * `localMessages` are app-owned history used for attachment rehydration and diagnostics,
 * while `turnInput` is the only user content serialized into the next model request.
 */
export type StreamAgentParams = Readonly<{
  localMessages: ReadonlyArray<ChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  userId: string;
  workspaceId: string;
  sessionId: string;
  conversationId: string | null;
  timezone: string;
  requestId: string;
  maxTurns: number;
  attempt?: number;
  autoContinuationUsed?: boolean;
  continuationBudgetRemaining?: number;
  signal?: AbortSignal;
}>;

type RawTextEvent = Readonly<{
  type: string;
  delta?: string;
  providerData?: unknown;
  event?: unknown;
}>;

type RawModelStreamEvent = Readonly<{
  type: "raw_model_stream_event";
  data: RawTextEvent;
}>;

type ToolCalledRunItemEvent = Readonly<{
  type: "run_item_stream_event";
  name: "tool_called";
  item: Readonly<{
    type: "tool_call_item";
    rawItem: FunctionToolCallRawItem | HostedToolCallRawItem;
  }>;
}>;

type ToolOutputRunItemEvent = Readonly<{
  type: "run_item_stream_event";
  name: "tool_output";
  item: Readonly<{
    type: "tool_call_output_item";
    rawItem: ToolCallOutputRawItem;
    output: unknown;
  }>;
}>;

export type OpenAIRunStreamEvent =
  | RawModelStreamEvent
  | ToolCalledRunItemEvent
  | ToolOutputRunItemEvent
  | Readonly<{
    type: string;
    name?: string;
    item?: unknown;
    data?: unknown;
  }>;

export type AgentRunResult = AsyncIterable<OpenAIRunStreamEvent> & Readonly<{
  rawResponses: ReadonlyArray<ModelResponse>;
  finalOutput: unknown;
  state: Readonly<{
    toJSON: () => unknown;
  }>;
  completed: Promise<void>;
}>;

type RunAgentParams = Readonly<{
  agent: Agent<AgentContext>;
  input: ReadonlyArray<AgentInputItem>;
  context: AgentContext;
  conversationId: string | undefined;
  groupId: string;
  traceMetadata: Readonly<Record<string, string>>;
  maxTurns: number;
  signal?: AbortSignal;
}>;

type CompletedAgentResponse = Readonly<{
  conversationId: string;
}>;

export type StartAgentResponseResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  completion: Promise<CompletedAgentResponse>;
  conversationId: string;
}>;

type StartAgentResponseDependencies = Readonly<{
  createClient: () => OpenAI;
  createConversation: (
    client: OpenAI,
    params: Readonly<{
      requestId: string;
      userId: string;
      workspaceId: string;
      sessionId: string;
    }>,
  ) => Promise<Readonly<{ id: string }>>;
  persistConversationId: (
    params: Readonly<{
      userId: string;
      workspaceId: string;
      sessionId: string;
      conversationId: string;
    }>,
  ) => Promise<void>;
  resolveManagedContainer: typeof resolveServerManagedContainer;
  runAgent: (params: RunAgentParams) => Promise<AgentRunResult>;
  addFilesToOpenAIContainer: typeof addFilesToOpenAIContainer;
  listOpenAIContainerInventory: typeof listOpenAIContainerInventory;
  verifySpreadsheetContainers: typeof verifySpreadsheetContainers;
  logEvent: typeof log;
  now: () => number;
}>;

export const CHAT_RUN_MAX_TURNS = 30;

/**
 * Creates the per-turn OpenAI agent configuration while keeping explicit code interpreter
 * containers enabled. The app intentionally reuses explicit containers so file availability
 * can survive across turns and be rehydrated from local history when a container expires.
 */
const createOpenAIAgent = (
  timezone: string,
  effectiveContainerId: string,
  forcedToolChoice: "code_interpreter" | null,
): Agent<AgentContext> =>
  new Agent<AgentContext>({
    name: "Expense Assistant",
    instructions: buildOpenaiInstructions(timezone, true),
    model: CHAT_MODEL_ID,
    modelSettings: buildOpenAIModelSettings(forcedToolChoice),
    tools: [
      pgQueryTool,
      codeInterpreterTool({ container: effectiveContainerId }),
      webSearchTool({ searchContextSize: "medium" }),
    ],
  });

/**
 * Runs a single streamed OpenAI turn through an SDK `Runner` so tracing metadata is attached at
 * the runner level, while `conversationId` continues the OpenAI-managed conversation state.
 * The underlying model settings enable `store: true`, which is required for this runtime memory
 * approach even though the app still stores the full chat transcript locally in Postgres.
 */
const runAgentWithTracing = async (
  params: RunAgentParams,
): Promise<AgentRunResult> => {
  const runner = new Runner({
    groupId: params.groupId,
    traceMetadata: { ...params.traceMetadata },
  });

  return await runner.run(params.agent, [...params.input], {
    stream: true,
    context: params.context,
    conversationId: params.conversationId,
    maxTurns: params.maxTurns,
    signal: params.signal,
  }) as AgentRunResult;
};

const createConversation = async (
  client: OpenAI,
  params: Readonly<{
    requestId: string;
    userId: string;
    workspaceId: string;
    sessionId: string;
  }>,
): Promise<Readonly<{ id: string }>> => {
  const conversation = await client.conversations.create({
    metadata: {
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
  });

  return { id: conversation.id };
};

const DEFAULT_START_AGENT_RESPONSE_DEPENDENCIES: StartAgentResponseDependencies = {
  createClient: (): OpenAI => new OpenAI(),
  createConversation,
  persistConversationId: async (params): Promise<void> =>
    persistChatSessionConversationId(params.userId, params.workspaceId, {
      sessionId: params.sessionId,
      conversationId: params.conversationId,
    }),
  resolveManagedContainer: resolveServerManagedContainer,
  runAgent: runAgentWithTracing,
  addFilesToOpenAIContainer,
  listOpenAIContainerInventory,
  verifySpreadsheetContainers,
  logEvent: log,
  now: (): number => Date.now(),
};

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

const getOptionalStringField = (
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
};

const isRawTextEvent = (value: unknown): value is RawTextEvent =>
  isRecord(value) && typeof value.type === "string";

const buildHostedToolCallRawItem = (
  rawItem: Readonly<Record<string, unknown>>,
  itemType: string,
): HostedToolCallRawItem => ({
  type: "hosted_tool_call",
  id: getOptionalStringField(rawItem, "id"),
  name: itemType,
  arguments: getOptionalStringField(rawItem, "arguments"),
  status: getOptionalStringField(rawItem, "status"),
  output: getOptionalStringField(rawItem, "output"),
  providerData: rawItem,
});

const isHostedToolCallType = (
  itemType: string,
): boolean =>
  itemType.endsWith("_call");

const parseOutputItemAddedToolEvent = (
  rawEvent: unknown,
): Readonly<{
  rawItem: FunctionToolCallRawItem | HostedToolCallRawItem;
  position: ToolCallPosition;
}> | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.output_item.added") {
    return null;
  }

  const errorPrefix = `OpenAI response.output_item.added event is invalid: ${JSON.stringify(rawEvent)}`;
  const rawItem = rawEvent.item;
  if (!isRecord(rawItem)) {
    throw new Error(`${errorPrefix}: missing item object`);
  }

  const itemType = getRequiredStringField(rawItem, "type", errorPrefix);
  const itemId = getRequiredStringField(rawItem, "id", errorPrefix);
  const position: ToolCallPosition = {
    itemId,
    outputIndex: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    sequenceNumber: getRequiredNumberField(rawEvent, "sequence_number", errorPrefix),
  };

  if (itemType === "function_call") {
    return {
      rawItem: {
        type: "function_call",
        callId: getRequiredStringField(rawItem, "call_id", errorPrefix),
        id: itemId,
        name: getRequiredStringField(rawItem, "name", errorPrefix),
        arguments: getOptionalStringField(rawItem, "arguments"),
        status: getOptionalStringField(rawItem, "status"),
      },
      position,
    };
  }

  if (!isHostedToolCallType(itemType)) {
    return null;
  }

  return {
    rawItem: buildHostedToolCallRawItem(rawItem, itemType),
    position,
  };
};

const parseFunctionCallArgumentsDeltaEvent = (
  rawEvent: unknown,
): FunctionCallArgumentsDeltaEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.function_call_arguments.delta") {
    return null;
  }

  const errorPrefix = `OpenAI response.function_call_arguments.delta event is invalid: ${JSON.stringify(rawEvent)}`;
  return {
    itemId: getRequiredStringField(rawEvent, "item_id", errorPrefix),
    outputIndex: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    sequenceNumber: getRequiredNumberField(rawEvent, "sequence_number", errorPrefix),
    delta: getRequiredStringField(rawEvent, "delta", errorPrefix),
  };
};

const parseFunctionCallArgumentsDoneEvent = (
  rawEvent: unknown,
): FunctionCallArgumentsDoneEvent | null => {
  if (!isRecord(rawEvent) || rawEvent.type !== "response.function_call_arguments.done") {
    return null;
  }

  const errorPrefix = `OpenAI response.function_call_arguments.done event is invalid: ${JSON.stringify(rawEvent)}`;
  return {
    itemId: getRequiredStringField(rawEvent, "item_id", errorPrefix),
    outputIndex: getRequiredNumberField(rawEvent, "output_index", errorPrefix),
    sequenceNumber: getRequiredNumberField(rawEvent, "sequence_number", errorPrefix),
    arguments: getRequiredStringField(rawEvent, "arguments", errorPrefix),
  };
};

const isRawModelStreamEvent = (
  event: OpenAIRunStreamEvent,
): event is RawModelStreamEvent =>
  event.type === "raw_model_stream_event" && isRawTextEvent(event.data);

const isToolCalledRunItemEvent = (
  event: OpenAIRunStreamEvent,
): event is ToolCalledRunItemEvent =>
  event.type === "run_item_stream_event"
  && event.name === "tool_called"
  && isRecord(event.item)
  && event.item.type === "tool_call_item"
  && "rawItem" in event.item;

const isToolOutputRunItemEvent = (
  event: OpenAIRunStreamEvent,
): event is ToolOutputRunItemEvent =>
  event.type === "run_item_stream_event"
  && event.name === "tool_output"
  && isRecord(event.item)
  && event.item.type === "tool_call_output_item"
  && "rawItem" in event.item;

const logContainerInventory = (
  logEvent: typeof log,
  requestId: string,
  effectiveContainerId: string,
  attachmentFileNames: ReadonlyArray<string>,
  responseId: string | undefined,
  containerFilePaths: ReadonlyArray<string>,
): void => {
  logEvent({
    domain: "chat",
    action: "code_interpreter_container_inventory",
    vendor: "openai",
    requestId,
    effectiveContainerId,
    attachmentFileNames,
    responseId,
    containerFilePaths,
  });
};

/**
 * Starts a streamed browser-chat turn while keeping the app's local transcript and OpenAI's
 * runtime conversation state intentionally separate.
 *
 * Local history is loaded so we can rehydrate attachments into the explicit code interpreter
 * container, keep audit/debug visibility, and preserve the UI transcript. The model request,
 * however, contains only the current turn and continues prior context solely through
 * `conversationId`.
 */
export const startAgentResponseWithDeps = async (
  params: StreamAgentParams,
  dependencies: StartAgentResponseDependencies,
): Promise<StartAgentResponseResult> => {
  const client = dependencies.createClient();
  let effectiveConversationId = params.conversationId;
  if (effectiveConversationId === null) {
    effectiveConversationId = (await dependencies.createConversation(client, {
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    })).id;
    await dependencies.persistConversationId({
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      conversationId: effectiveConversationId,
    });
  }
  const latestFileAttachments = getLatestUserFileAttachments(params.localMessages);
  const conversationFileAttachments = getAllUserFileAttachments(params.localMessages);
  const attachmentFileNames = latestFileAttachments.map((part) => part.fileName);
  const conversationAttachmentFileNames = conversationFileAttachments.map((part) => part.fileName);
  const attachmentMediaTypes = latestFileAttachments.map((part) => part.mediaType);
  const spreadsheetAttachmentFileNames = getSpreadsheetAttachmentFileNames(latestFileAttachments);
  const effectiveContainerId = await dependencies.resolveManagedContainer(
    client,
    params.requestId,
    params.userId,
    params.workspaceId,
    params.sessionId,
    buildOpenAIContainerName,
    isOpenAIContainerExpired,
  );
  const forcedToolChoice = spreadsheetAttachmentFileNames.length > 0 ? "code_interpreter" : null;
  let rehydratedAttachmentCount = 0;

  if (conversationFileAttachments.length > 0) {
    const initialInventory = await dependencies.listOpenAIContainerInventory(client, effectiveContainerId);
    const missingAttachments = conversationFileAttachments.filter((attachment) =>
      !containerHasAttachment(initialInventory.filePaths, attachment.fileName),
    );
    const latestAttachmentSignatures = new Set(
      latestFileAttachments.map((attachment) =>
        `${attachment.fileName}\u0000${attachment.mediaType}\u0000${attachment.base64Data}`,
      ),
    );

    for (const attachment of missingAttachments) {
      await dependencies.addFilesToOpenAIContainer(client, effectiveContainerId, [attachment]);
      const signature = `${attachment.fileName}\u0000${attachment.mediaType}\u0000${attachment.base64Data}`;
      const attachmentSource = latestAttachmentSignatures.has(signature)
        ? "latest_message"
        : "history_rehydrate";
      if (attachmentSource === "history_rehydrate") {
        rehydratedAttachmentCount += 1;
      }
      dependencies.logEvent({
        domain: "chat",
        action: "code_interpreter_container_file_added",
        vendor: "openai",
        requestId: params.requestId,
        effectiveContainerId,
        attachmentFileName: attachment.fileName,
        attachmentSource,
      });
    }

    const syncedInventory = missingAttachments.length === 0
      ? initialInventory
      : await dependencies.listOpenAIContainerInventory(client, effectiveContainerId);
    logContainerInventory(
      dependencies.logEvent,
      params.requestId,
      effectiveContainerId,
      conversationAttachmentFileNames,
      undefined,
      syncedInventory.filePaths,
    );
  }

  const agent = createOpenAIAgent(params.timezone, effectiveContainerId, forcedToolChoice);
  const context: AgentContext = {
    userId: params.userId,
    workspaceId: params.workspaceId,
  };
  const input = buildInput(params.turnInput);
  const hasAttachments = params.turnInput.some((part) => part.type !== "text");

  dependencies.logEvent({
    domain: "chat",
    action: "request",
    vendor: "openai",
    model: CHAT_MODEL_ID,
    requestId: params.requestId,
    messageCount: 1,
    hasAttachments,
    attachmentCount: latestFileAttachments.length,
    attachmentFileNames,
    attachmentMediaTypes,
    spreadsheetAttachmentFileNames,
    conversationAttachmentCount: conversationFileAttachments.length,
    conversationAttachmentFileNames,
    rehydratedAttachmentCount,
    effectiveContainerId,
    forcedToolChoice,
    ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
    maxTurns: params.maxTurns,
    autoContinuationUsed: params.autoContinuationUsed ?? false,
    continuationBudgetRemaining: params.continuationBudgetRemaining,
  });
  const requestStart = dependencies.now();

  const result = await dependencies.runAgent({
    agent,
    input,
    context,
    conversationId: effectiveConversationId,
    groupId: params.sessionId,
    traceMetadata: {
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
    maxTurns: params.maxTurns,
    signal: params.signal,
  });
  const completion = (async (): Promise<CompletedAgentResponse> => {
    await result.completed;
    return { conversationId: effectiveConversationId };
  })();
  void completion.catch((): void => undefined);

  const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
    let toolCalls = 0;
    let textStates: TextStreamState = createTextStreamState();
    let toolStates = createToolCallStateMap();

    try {
      for await (const event of result) {
        if (isRawModelStreamEvent(event)) {
          const outputItemAddedToolEvent = parseOutputItemAddedToolEvent(event.data.event);
          if (outputItemAddedToolEvent !== null) {
            const update = applyToolCallStarted(
              toolStates,
              outputItemAddedToolEvent.rawItem,
              outputItemAddedToolEvent.position,
              dependencies.now(),
            );
            toolStates = update.toolStates;

            if (update.started) {
              dependencies.logEvent({
                domain: "chat",
                action: "tool_call",
                vendor: "openai",
                tool: update.event?.name ?? outputItemAddedToolEvent.rawItem.name,
                status: "started",
              });
            }
            if (update.completed && update.durationMs !== null && update.event !== null) {
              dependencies.logEvent({
                domain: "chat",
                action: "tool_call",
                vendor: "openai",
                tool: update.event.name,
                status: "completed",
                durationMs: update.durationMs,
              });
              toolCalls++;
            }
            if (update.event !== null) {
              yield update.event;
            }
          }

          const textUpdate = applyRawTextStreamEvent(textStates, event.data);
          textStates = textUpdate.textStates;
          if (textUpdate.emittedDelta !== null) {
            yield {
              type: "delta",
              text: textUpdate.emittedDelta.text,
              itemId: textUpdate.emittedDelta.itemId,
              outputIndex: textUpdate.emittedDelta.outputIndex,
              contentIndex: textUpdate.emittedDelta.contentIndex,
              sequenceNumber: textUpdate.emittedDelta.sequenceNumber,
            };
          }

          const functionArgumentsDeltaEvent = parseFunctionCallArgumentsDeltaEvent(event.data.event);
          if (functionArgumentsDeltaEvent !== null) {
            const update = applyFunctionCallArgumentsDelta(toolStates, functionArgumentsDeltaEvent);
            toolStates = update.toolStates;
            if (update.event !== null) {
              yield update.event;
            }
          }

          const functionArgumentsDoneEvent = parseFunctionCallArgumentsDoneEvent(event.data.event);
          if (functionArgumentsDoneEvent !== null) {
            const update = applyFunctionCallArgumentsDone(toolStates, functionArgumentsDoneEvent);
            toolStates = update.toolStates;
            if (update.event !== null) {
              yield update.event;
            }
          }
          continue;
        }

        if (isToolCalledRunItemEvent(event)) {
          const toolId = getRequiredToolCallId(event.item.rawItem);
          const position = getTrackedToolCallPosition(toolStates, toolId);
          if (position === null) {
            throw new Error(
              `OpenAI tool_called event arrived before response.output_item.added for tool_id=${toolId}`,
            );
          }
          const update = applyToolCallStarted(toolStates, event.item.rawItem, position, dependencies.now());
          toolStates = update.toolStates;

          if (update.started) {
            dependencies.logEvent({
              domain: "chat",
              action: "tool_call",
              vendor: "openai",
              tool: event.item.rawItem.name,
              status: "started",
            });
          }
          if (update.completed && update.durationMs !== null && update.event !== null) {
            dependencies.logEvent({
              domain: "chat",
              action: "tool_call",
              vendor: "openai",
              tool: update.event.name,
              status: "completed",
              durationMs: update.durationMs,
            });
            toolCalls++;
          }
          if (update.event !== null) {
            yield update.event;
          }
          continue;
        }

        if (isToolOutputRunItemEvent(event)) {
          const update = applyToolCallOutput(
            toolStates,
            event.item.rawItem,
            event.item.output,
            dependencies.now(),
          );
          toolStates = update.toolStates;

          if (update.completed && update.durationMs !== null && update.event !== null) {
            dependencies.logEvent({
              domain: "chat",
              action: "tool_call",
              vendor: "openai",
              tool: update.event.name,
              status: "completed",
              durationMs: update.durationMs,
            });
            toolCalls++;
          }
          if (update.event !== null) {
            yield update.event;
          }
        }
      }

      const finalizedUpdates = finalizePendingToolCalls(toolStates, dependencies.now());
      toolStates = finalizedUpdates.toolStates;

      for (const finalized of finalizedUpdates.finalized) {
        dependencies.logEvent({
          domain: "chat",
          action: "tool_call",
          vendor: "openai",
          tool: finalized.event.name,
          status: "completed",
          durationMs: finalized.durationMs,
        });
        toolCalls++;
        yield finalized.event;
      }

      if (spreadsheetAttachmentFileNames.length > 0) {
        const verificationResults = await dependencies.verifySpreadsheetContainers(
          client,
          result.rawResponses,
          spreadsheetAttachmentFileNames,
        );

        for (const verificationResult of verificationResults) {
          if (verificationResult.status === "missing_code_interpreter") {
            dependencies.logEvent({
              domain: "chat",
              action: "spreadsheet_container_missing_code_interpreter",
              vendor: "openai",
              attachmentFileNames: verificationResult.attachmentFileNames,
              responseId: verificationResult.responseId,
              requestId: verificationResult.requestId,
            });
            continue;
          }

          if (verificationResult.status === "verification_failed") {
            dependencies.logEvent({
              domain: "chat",
              action: "spreadsheet_container_verification_failed",
              vendor: "openai",
              attachmentFileNames: verificationResult.attachmentFileNames,
              responseId: verificationResult.responseId,
              requestId: verificationResult.requestId,
              containerId: verificationResult.containerId,
              error: verificationResult.error,
            });
            continue;
          }

          dependencies.logEvent({
            domain: "chat",
            action: "spreadsheet_container_verified",
            vendor: "openai",
            attachmentFileNames: verificationResult.attachmentFileNames,
            responseId: verificationResult.responseId,
            requestId: verificationResult.requestId,
            containerId: verificationResult.containerId,
            containerFilePaths: verificationResult.filePaths,
          });
          logContainerInventory(
            dependencies.logEvent,
            params.requestId,
            effectiveContainerId,
            verificationResult.attachmentFileNames,
            verificationResult.responseId,
            verificationResult.filePaths,
          );
        }
      } else {
        const finalInventory = await dependencies.listOpenAIContainerInventory(client, effectiveContainerId);
        logContainerInventory(
          dependencies.logEvent,
          params.requestId,
          effectiveContainerId,
          attachmentFileNames,
          undefined,
          finalInventory.filePaths,
        );
      }

      const responseSummary = summarizeOpenAIResponse(
        result.rawResponses,
        typeof result.finalOutput === "string" ? result.finalOutput : undefined,
      );
      dependencies.logEvent({
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
      dependencies.logEvent({
        domain: "chat",
        action: "response",
        vendor: "openai",
        requestId: params.requestId,
        turns: toolCalls,
        stopReason: "done",
        durationMs: dependencies.now() - requestStart,
        ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
        maxTurns: params.maxTurns,
        autoContinuationUsed: params.autoContinuationUsed ?? false,
        continuationBudgetRemaining: params.continuationBudgetRemaining,
      });
      await completion;
    } catch (error) {
      if (error instanceof MaxTurnsExceededError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      dependencies.logEvent({
        domain: "chat",
        action: "error",
        vendor: "openai",
        stage: "agent",
        error: errorMessage,
        requestId: params.requestId,
        userId: params.userId,
        workspaceId: params.workspaceId,
        model: CHAT_MODEL_ID,
        messageCount: 1,
        hasAttachments,
        attachmentFileNames,
        effectiveContainerId,
        ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
        maxTurns: params.maxTurns,
        autoContinuationUsed: params.autoContinuationUsed ?? false,
        continuationBudgetRemaining: params.continuationBudgetRemaining,
      });
      throw error;
    }

    yield { type: "done" };
  })();

  return {
    events,
    completion,
    conversationId: effectiveConversationId,
  };
};

export const startAgentResponse = async (
  params: StreamAgentParams,
): Promise<StartAgentResponseResult> =>
  startAgentResponseWithDeps(params, DEFAULT_START_AGENT_RESPONSE_DEPENDENCIES);
