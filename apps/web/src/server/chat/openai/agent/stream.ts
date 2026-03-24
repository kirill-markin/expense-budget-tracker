import { Agent, Runner } from "@openai/agents";
import type { AgentInputItem, ModelResponse } from "@openai/agents-core";
import { codeInterpreterTool, webSearchTool } from "@openai/agents-openai";
import OpenAI from "openai";
import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { ChatMessage, ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { log } from "@/server/logger";
import { resolveServerManagedContainer } from "../containerState";
import { pgQueryTool, type AgentContext } from "../tools";
import { buildOpenAIModelSettings, buildOpenaiInstructions } from "./config";
import { extractConversationId } from "./conversationState";
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
  applyToolCallOutput,
  applyToolCallStarted,
  createToolCallStateMap,
  finalizePendingToolCalls,
  type FunctionToolCallRawItem,
  type HostedToolCallRawItem,
  type ToolCallOutputRawItem,
} from "./toolCalls";

export type StreamAgentParams = Readonly<{
  localMessages: ReadonlyArray<ChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  userId: string;
  workspaceId: string;
  sessionId: string;
  conversationId: string | null;
  timezone: string;
  requestId: string;
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

type StartAgentResponseResult = Readonly<{
  events: AsyncGenerator<ChatStreamEvent>;
  completion: Promise<CompletedAgentResponse>;
}>;

type StartAgentResponseDependencies = Readonly<{
  createClient: () => OpenAI;
  resolveManagedContainer: typeof resolveServerManagedContainer;
  runAgent: (params: RunAgentParams) => Promise<AgentRunResult>;
  addFilesToOpenAIContainer: typeof addFilesToOpenAIContainer;
  listOpenAIContainerInventory: typeof listOpenAIContainerInventory;
  verifySpreadsheetContainers: typeof verifySpreadsheetContainers;
  logEvent: typeof log;
  now: () => number;
}>;

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

const DEFAULT_START_AGENT_RESPONSE_DEPENDENCIES: StartAgentResponseDependencies = {
  createClient: (): OpenAI => new OpenAI(),
  resolveManagedContainer: resolveServerManagedContainer,
  runAgent: async (params: RunAgentParams): Promise<AgentRunResult> => {
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
  },
  addFilesToOpenAIContainer,
  listOpenAIContainerInventory,
  verifySpreadsheetContainers,
  logEvent: log,
  now: (): number => Date.now(),
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRawTextEvent = (value: unknown): value is RawTextEvent =>
  isRecord(value) && typeof value.type === "string";

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

export const startAgentResponseWithDeps = async (
  params: StreamAgentParams,
  dependencies: StartAgentResponseDependencies,
): Promise<StartAgentResponseResult> => {
  const client = dependencies.createClient();
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
  });
  const requestStart = dependencies.now();

  const result = await dependencies.runAgent({
    agent,
    input,
    context,
    conversationId: params.conversationId ?? undefined,
    groupId: params.sessionId,
    traceMetadata: {
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    },
    maxTurns: 10,
    signal: params.signal,
  });
  const completion = (async (): Promise<CompletedAgentResponse> => {
    await result.completed;
    const conversationId = extractConversationId(result.state);
    if (conversationId === null) {
      throw new Error("OpenAI conversationId missing after completed server-managed chat run");
    }

    return { conversationId };
  })();

  const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
    let toolCalls = 0;
    let textStates: TextStreamState = createTextStreamState();
    let toolStates = createToolCallStateMap();

    try {
      for await (const event of result) {
        if (isRawModelStreamEvent(event)) {
          const textUpdate = applyRawTextStreamEvent(textStates, event.data);
          textStates = textUpdate.textStates;
          if (textUpdate.emittedDelta !== null) {
            yield { type: "delta", text: textUpdate.emittedDelta };
          }
          continue;
        }

        if (isToolCalledRunItemEvent(event)) {
          const update = applyToolCallStarted(toolStates, event.item.rawItem, dependencies.now());
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
      });
      await completion;
    } catch (error) {
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
      });
      throw error;
    }

    yield { type: "done" };
  })();

  return {
    events,
    completion,
  };
};

export const startAgentResponse = async (
  params: StreamAgentParams,
): Promise<StartAgentResponseResult> =>
  startAgentResponseWithDeps(params, DEFAULT_START_AGENT_RESPONSE_DEPENDENCIES);
