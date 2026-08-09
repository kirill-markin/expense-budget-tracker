import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  executeChatToolCall,
  type ChatToolExecutionError,
  type ExecutedChatToolCall,
} from "@/server/chat/openai/tooling/tools";

type ToolExecutorDependencies = Readonly<{
  executeChatToolCall: typeof executeChatToolCall;
}>;

const DEFAULT_TOOL_EXECUTOR_DEPENDENCIES: ToolExecutorDependencies = {
  executeChatToolCall,
};

const sanitizeToolOutputForTelemetry = (
  output: string,
): string =>
  output.length <= 4_000
    ? output
    : `${output.slice(0, 4_000)}...`;

const formatToolErrorStatusMessage = (
  error: ChatToolExecutionError,
): string => `${error.name}: ${error.message}`;

const serializeThrownToolError = (
  error: unknown,
): ChatToolExecutionError => error instanceof Error
  ? {
    name: error.name,
    message: error.message,
  }
  : {
    name: "Error",
    message: String(error),
  };

/**
 * Executes a single local tool call and returns both the serialized tool
 * output and the canonical metadata later used for route invalidation.
 *
 * This keeps the refresh contract grounded in the executed SQL/result pair
 * instead of in earlier streamed tool-call snapshots.
 */
export const runOneToolCallWithDependencies = async (
  params: Readonly<{
    item: OpenAI.Responses.ResponseFunctionToolCall;
    userId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    rootObservation: LangfuseObservation | null;
  }>,
  dependencies: ToolExecutorDependencies,
): Promise<ExecutedChatToolCall> => {
  const toolObservation = params.rootObservation?.startObservation(
    params.item.name,
    {
      input: {
        arguments: params.item.arguments,
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
      },
    },
    {
      asType: "tool",
    },
  ) ?? null;

  const startedAt = Date.now();
  try {
    let output: ExecutedChatToolCall;
    try {
      output = await dependencies.executeChatToolCall(
        params.item.name,
        params.item.arguments,
        {
          userId: params.userId,
          workspaceId: params.workspaceId,
          sessionId: params.sessionId,
          turnId: params.turnId,
        },
      );
    } catch (error) {
      const serializedError = serializeThrownToolError(error);
      toolObservation?.updateOtelSpanAttributes({
        output: {
          error: serializedError.message,
        },
        metadata: {
          toolName: params.item.name,
          toolCallId: params.item.call_id,
          durationMs: String(Date.now() - startedAt),
        },
      });
      toolObservation?.update({
        level: "ERROR",
        statusMessage: formatToolErrorStatusMessage(serializedError),
      });
      throw error;
    }

    toolObservation?.updateOtelSpanAttributes({
      output: {
        output: sanitizeToolOutputForTelemetry(output.output),
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
        durationMs: String(Date.now() - startedAt),
      },
    });
    if (!output.succeeded) {
      toolObservation?.update({
        level: "ERROR",
        statusMessage: formatToolErrorStatusMessage(output.error),
      });
    }
    return output;
  } finally {
    toolObservation?.end();
  }
};

export const runOneToolCall = async (
  params: Parameters<typeof runOneToolCallWithDependencies>[0],
): Promise<ExecutedChatToolCall> =>
  runOneToolCallWithDependencies(
    params,
    DEFAULT_TOOL_EXECUTOR_DEPENDENCIES,
  );
