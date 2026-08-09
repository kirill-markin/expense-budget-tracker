import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  executeChatToolCall,
  type ChatToolExecutionError,
  type ExecutedChatToolCall,
} from "@/server/chat/openai/tooling/tools";
import { log } from "@/server/logger";

type ToolExecutorParams = Readonly<{
  item: OpenAI.Responses.ResponseFunctionToolCall;
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  rootObservation: LangfuseObservation | null;
}>;

type ToolTelemetryOperation = "update_attributes" | "update" | "end";

type ToolExecutorDependencies = Readonly<{
  executeChatToolCall: typeof executeChatToolCall;
  log: typeof log;
}>;

const DEFAULT_TOOL_EXECUTOR_DEPENDENCIES: ToolExecutorDependencies = {
  executeChatToolCall,
  log,
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

const logToolTelemetryError = (
  params: ToolExecutorParams,
  operation: ToolTelemetryOperation,
  error: unknown,
  logger: typeof log,
): void => {
  logger({
    domain: "chat",
    action: "error",
    vendor: "openai",
    stage: "agent",
    error: `Langfuse tool observation ${operation} failed for ${params.item.name} (${params.item.call_id}): ${error instanceof Error ? error.message : String(error)}`,
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
};

const runToolTelemetryOperation = (
  params: ToolExecutorParams,
  operation: ToolTelemetryOperation,
  telemetryOperation: () => void,
  logger: typeof log,
): void => {
  try {
    telemetryOperation();
  } catch (error) {
    logToolTelemetryError(params, operation, error, logger);
  }
};

/**
 * Executes a single local tool call and returns both the serialized tool
 * output and the canonical metadata later used for route invalidation.
 *
 * This keeps the refresh contract grounded in the executed SQL/result pair
 * instead of in earlier streamed tool-call snapshots.
 */
export const runOneToolCallWithDependencies = async (
  params: ToolExecutorParams,
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
      runToolTelemetryOperation(
        params,
        "update_attributes",
        (): void => toolObservation?.updateOtelSpanAttributes({
          output: {
            error: serializedError.message,
          },
          metadata: {
            toolName: params.item.name,
            toolCallId: params.item.call_id,
            durationMs: String(Date.now() - startedAt),
          },
        }),
        dependencies.log,
      );
      runToolTelemetryOperation(
        params,
        "update",
        (): void => {
          toolObservation?.update({
            level: "ERROR",
            statusMessage: formatToolErrorStatusMessage(serializedError),
          });
        },
        dependencies.log,
      );
      throw error;
    }

    runToolTelemetryOperation(
      params,
      "update_attributes",
      (): void => toolObservation?.updateOtelSpanAttributes({
        output: {
          output: sanitizeToolOutputForTelemetry(output.output),
        },
        metadata: {
          toolName: params.item.name,
          toolCallId: params.item.call_id,
          durationMs: String(Date.now() - startedAt),
        },
      }),
      dependencies.log,
    );
    if (!output.succeeded) {
      runToolTelemetryOperation(
        params,
        "update",
        (): void => {
          toolObservation?.update({
            level: "ERROR",
            statusMessage: formatToolErrorStatusMessage(output.error),
          });
        },
        dependencies.log,
      );
    }
    return output;
  } finally {
    runToolTelemetryOperation(
      params,
      "end",
      (): void => toolObservation?.end(),
      dependencies.log,
    );
  }
};

export const runOneToolCall = async (
  params: Parameters<typeof runOneToolCallWithDependencies>[0],
): Promise<ExecutedChatToolCall> =>
  runOneToolCallWithDependencies(
    params,
    DEFAULT_TOOL_EXECUTOR_DEPENDENCIES,
  );
