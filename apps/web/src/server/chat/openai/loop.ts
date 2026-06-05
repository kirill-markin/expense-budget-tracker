import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { SupportedLocale } from "@/lib/locale";
import { ti } from "@/i18n/serverT";
import {
  applyToolCallOutput,
} from "@/server/chat/openai/tooling/toolCalls";
import { buildChatCompletionInput } from "@/server/chat/openai/responses/input";
import { getObservedOpenAIClient } from "@/server/chat/openai/client";
import {
  type StoredOpenAIReplayMessage,
  type ServerChatMessage,
  type StoredOpenAIReplayItem,
  toStoredOpenAIReplayItem,
} from "@/server/chat/openai/responses/replayItems";
import {
  buildOpenAIResponsesRequest,
  buildOpenAIResponsesRequestWithOptions,
  buildPromptCacheKey,
  type OpenAIResponsesRequest,
} from "@/server/chat/openai/responses/request";
import {
  runOneModelCall,
  type ModelCallResult,
} from "@/server/chat/openai/responses/modelCall";
import { runOneToolCall } from "@/server/chat/openai/tooling/toolExecutor";
import {
  classifyOpenAITransientError,
  extractOpenAIErrorContext,
  parseRetryAfterMs,
} from "@/server/chat/logging";
import type { ChatStreamEvent, ContentPart } from "@/server/chat/types";
import { log as serverLog } from "@/server/logger";

export const CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS = 30;
const TOOL_LIMIT_FALLBACK_ITEM_ID = "tool-limit-summary";

const MODEL_CALL_RETRY_BACKOFF_MS: ReadonlyArray<number> = [5_000, 20_000];
const MODEL_CALL_RETRY_JITTER = 0.2;
// Loop-level retry policy cap: if the server's Retry-After exceeds this,
// surface the error instead of waiting. Distinct from the parser-level 24h
// sanity cap in logging.ts (which filters obviously-malformed values before
// they ever reach this check).
const MODEL_CALL_RETRY_MAX_DELAY_MS = 60_000;

const computeRetryDelayMs = (
  backoffMs: ReadonlyArray<number>,
  attempt: number,
): number => {
  const base = backoffMs[attempt - 1];
  if (base === undefined) {
    throw new Error(`No backoff defined for retry attempt ${String(attempt)}`);
  }
  const jitter = base * MODEL_CALL_RETRY_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
};

const sleepWithAbort = (
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

type OpenAILoopDependencies = Readonly<{
  buildChatCompletionInput: typeof buildChatCompletionInput;
  getObservedOpenAIClient: typeof getObservedOpenAIClient;
  runOneModelCall: typeof runOneModelCall;
  runOneToolCall: typeof runOneToolCall;
  getModelCallRetryBackoffMs: () => ReadonlyArray<number>;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  log: typeof serverLog;
}>;

export type OpenAILoopCompletion = Readonly<{
  openaiItems: ReadonlyArray<StoredOpenAIReplayItem>;
}>;

export type OpenAILoopEventHandler = (
  event: ChatStreamEvent,
) => void | Promise<void>;

export type StartOpenAILoopParams = Readonly<{
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  locale: SupportedLocale;
  timezone: string;
  localMessages: ReadonlyArray<ServerChatMessage>;
  turnInput: ReadonlyArray<ContentPart>;
  signal?: AbortSignal;
  rootObservation: LangfuseObservation | null;
}>;

const toFunctionCallOutputInputItem = (
  callId: string,
  output: string,
): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
  type: "function_call_output",
  call_id: callId,
  output,
});

const DEFAULT_OPENAI_LOOP_DEPENDENCIES: OpenAILoopDependencies = {
  buildChatCompletionInput,
  getObservedOpenAIClient,
  runOneModelCall,
  runOneToolCall,
  getModelCallRetryBackoffMs: (): ReadonlyArray<number> => MODEL_CALL_RETRY_BACKOFF_MS,
  sleep: sleepWithAbort,
  log: serverLog,
};

const createInputTextMessage = (
  role: "system" | "user",
  text: string,
): OpenAI.Responses.ResponseInputItem.Message => ({
  type: "message",
  role,
  content: [{
    type: "input_text",
    text,
  }],
});

const buildToolLimitSummaryInstruction = (
  toolEnabledModelCallLimit: number,
): OpenAI.Responses.ResponseInputItem.Message =>
  createInputTextMessage(
    "system",
    [
      `The tool-enabled model call limit for this turn (${String(toolEnabledModelCallLimit)}) has been reached.`,
      "Do not call any tools in this response.",
      "Briefly summarize what you already completed.",
      "Explicitly name the checkpoint that is fully completed.",
      "Briefly state what remains unfinished.",
      "Explicitly name the next pending checkpoint.",
      "Ask the user to send another message such as \"continue\" if they want you to keep going from the same chat session.",
      "Tell the user that the next message should resume from that checkpoint instead of restarting earlier completed batches.",
    ].join(" "),
  );

const buildToolLimitFallbackText = (
  locale: SupportedLocale,
): string =>
  ti(locale, "chat.toolCallLimitReachedContinue", {
    limit: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  });

const createAssistantReplayMessage = (
  text: string,
): StoredOpenAIReplayMessage => ({
  type: "message",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [{
    type: "output_text",
    text,
    annotations: [],
  }],
});

const pushSyntheticAssistantDelta = async (
  emitEvent: OpenAILoopEventHandler,
  text: string,
  responseIndex: number,
): Promise<void> => {
  if (text.trim().length === 0) {
    return;
  }

  await emitEvent({
    type: "delta",
    text,
    itemId: TOOL_LIMIT_FALLBACK_ITEM_ID,
    responseIndex,
    outputIndex: 0,
    contentIndex: 0,
    sequenceNumber: 0,
  });
};

/**
 * Builds an emitEvent wrapper that flips a flag on first invocation.
 *
 * Used by the retry helper to gate retries: if the failed attempt already
 * streamed any user-visible event (delta, tool_call, reasoning_summary), we
 * cannot retry without producing duplicate transcript content, so we surface
 * the error instead.
 */
const wrapEmitEventWithTracking = (
  emitEvent: OpenAILoopEventHandler,
): Readonly<{ trackingEmit: OpenAILoopEventHandler; hasEmitted: () => boolean }> => {
  let emittedAnyEvent = false;
  const trackingEmit: OpenAILoopEventHandler = async (event) => {
    emittedAnyEvent = true;
    await emitEvent(event);
  };
  return {
    trackingEmit,
    hasEmitted: (): boolean => emittedAnyEvent,
  };
};

type RunOneModelCallWithRetryArgs = Readonly<{
  runOneModelCallFn: typeof runOneModelCall;
  backoffMs: ReadonlyArray<number>;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  log: typeof serverLog;
  client: OpenAI;
  params: StartOpenAILoopParams;
  emitEvent: OpenAILoopEventHandler;
  request: OpenAIResponsesRequest;
  promptCacheKey: string;
  callIndex: number;
}>;

const runOneModelCallWithRetry = async (
  args: RunOneModelCallWithRetryArgs,
): Promise<ModelCallResult> => {
  const { runOneModelCallFn, backoffMs, sleep, log, client, params, emitEvent, request, promptCacheKey, callIndex } = args;
  const maxAttempts = backoffMs.length + 1;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    const { trackingEmit, hasEmitted } = wrapEmitEventWithTracking(emitEvent);
    try {
      return await runOneModelCallFn(
        client,
        params,
        trackingEmit,
        request,
        promptCacheKey,
        callIndex,
      );
    } catch (error) {
      const classification = classifyOpenAITransientError(error);
      if (!classification.retryable || hasEmitted()) {
        throw error;
      }

      const retryAfterMs = parseRetryAfterMs(error);
      if (retryAfterMs !== undefined && retryAfterMs > MODEL_CALL_RETRY_MAX_DELAY_MS) {
        throw error;
      }

      const baseDelayMs = computeRetryDelayMs(backoffMs, attempt);
      const delayMs = Math.max(retryAfterMs ?? 0, baseDelayMs);
      log({
        domain: "chat",
        action: "model_call_retry",
        vendor: "openai",
        requestId: params.requestId,
        sessionId: params.sessionId,
        callIndex,
        attempt,
        maxAttempts,
        reason: classification.reason,
        delayMs,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        error: error instanceof Error ? error.message : String(error),
        ...extractOpenAIErrorContext(error),
      });
      await sleep(delayMs, params.signal);
    }
  }

  // Final attempt: no retry follows, so emit directly without the tracking wrapper.
  return runOneModelCallFn(
    client,
    params,
    emitEvent,
    request,
    promptCacheKey,
    callIndex,
  );
};

const completeToolLimitSummaryTurn = async (
  params: StartOpenAILoopParams,
  emitEvent: OpenAILoopEventHandler,
  runOneModelCallFn: typeof runOneModelCall,
  backoffMs: ReadonlyArray<number>,
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>,
  log: typeof serverLog,
  client: OpenAI,
  baseInput: ReadonlyArray<OpenAI.Responses.ResponseInputItem>,
  continuationItems: Array<StoredOpenAIReplayItem>,
  promptCacheKey: string,
): Promise<OpenAILoopCompletion> => {
  log({
    domain: "chat",
    action: "tool_call_limit_reached",
    vendor: "openai",
    requestId: params.requestId,
    sessionId: params.sessionId,
    toolEnabledModelCallLimit: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
    callIndex: CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS,
  });

  const summaryCallIndex = CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS + 1;
  const summaryCall = await runOneModelCallWithRetry({
    runOneModelCallFn,
    backoffMs,
    sleep,
    log,
    client,
    params,
    emitEvent,
    request: buildOpenAIResponsesRequestWithOptions(
      baseInput,
      continuationItems,
      params.userId,
      params.sessionId,
      params.timezone,
      [],
      [buildToolLimitSummaryInstruction(CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS)],
    ),
    promptCacheKey,
    callIndex: summaryCallIndex,
  });

  const finalResponseText = summaryCall.finalResponse.output_text.trim();
  const finalAssistantText = finalResponseText.length > 0
    ? finalResponseText
    : summaryCall.streamedText.trim();
  if (summaryCall.functionCalls.length === 0 && finalAssistantText.length > 0) {
    continuationItems.push(...summaryCall.replayItems);
    if (summaryCall.streamedText.length === 0) {
      await pushSyntheticAssistantDelta(emitEvent, finalAssistantText, summaryCallIndex - 1);
    }
    await emitEvent({ type: "done" });
    return {
      openaiItems: continuationItems,
    };
  }

  const fallbackText = buildToolLimitFallbackText(params.locale);
  continuationItems.push(createAssistantReplayMessage(fallbackText));
  if (summaryCall.streamedText.length === 0) {
    await pushSyntheticAssistantDelta(emitEvent, fallbackText, summaryCallIndex - 1);
  }
  await emitEvent({ type: "done" });
  return {
    openaiItems: continuationItems,
  };
};

const runLoopWithDeps = async (
  params: StartOpenAILoopParams,
  emitEvent: OpenAILoopEventHandler,
  dependencies: OpenAILoopDependencies,
): Promise<OpenAILoopCompletion> => {
  const client = dependencies.getObservedOpenAIClient();
  const baseInput = await dependencies.buildChatCompletionInput(
    params.localMessages,
    params.turnInput,
    params.timezone,
  );
  const continuationItems: Array<StoredOpenAIReplayItem> = [];
  const promptCacheKey = buildPromptCacheKey(params.sessionId);

  const retryBackoffMs = dependencies.getModelCallRetryBackoffMs();
  for (let callIndex = 1; callIndex <= CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS; callIndex += 1) {
    const modelCall = await runOneModelCallWithRetry({
      runOneModelCallFn: dependencies.runOneModelCall,
      backoffMs: retryBackoffMs,
      sleep: dependencies.sleep,
      log: dependencies.log,
      client,
      params,
      emitEvent,
      request: buildOpenAIResponsesRequest(
        baseInput,
        continuationItems,
        params.userId,
        params.sessionId,
        params.timezone,
      ),
      promptCacheKey,
      callIndex,
    });

    continuationItems.push(...modelCall.replayItems);

    if (modelCall.functionCalls.length === 0) {
      await emitEvent({ type: "done" });
      return {
        openaiItems: continuationItems,
      };
    }

    let toolStates = modelCall.toolStates;
    for (const functionCall of modelCall.functionCalls) {
      const output = await dependencies.runOneToolCall({
        item: functionCall,
        userId: params.userId,
        workspaceId: params.workspaceId,
        rootObservation: params.rootObservation,
      });
      const update = applyToolCallOutput(
        toolStates,
        {
          type: "function_call_output",
          callId: functionCall.call_id,
          id: functionCall.id,
          name: functionCall.name,
        },
        output.output,
        Date.now(),
        output.succeeded && output.isMutating,
      );
      toolStates = update.toolStates;
      if (update.event !== null) {
        await emitEvent(update.event);
      }
      continuationItems.push(toStoredOpenAIReplayItem(
        toFunctionCallOutputInputItem(functionCall.call_id, output.output),
      ));
    }

    if (callIndex === CHAT_RUN_MAX_TOOL_CALL_MODEL_CALLS) {
      return completeToolLimitSummaryTurn(
        params,
        emitEvent,
        dependencies.runOneModelCall,
        retryBackoffMs,
        dependencies.sleep,
        dependencies.log,
        client,
        baseInput,
        continuationItems,
        promptCacheKey,
      );
    }
  }

  throw new Error("OpenAI chat loop exceeded the expected control flow");
};

export const runOpenAILoopWithDeps = async (
  params: StartOpenAILoopParams,
  onEvent: OpenAILoopEventHandler,
  dependencies: OpenAILoopDependencies,
) => runLoopWithDeps(params, onEvent, dependencies);

export const runOpenAILoop = async (
  params: StartOpenAILoopParams,
  onEvent: OpenAILoopEventHandler,
): Promise<OpenAILoopCompletion> =>
  runOpenAILoopWithDeps(
    params,
    onEvent,
    DEFAULT_OPENAI_LOOP_DEPENDENCIES,
  );
