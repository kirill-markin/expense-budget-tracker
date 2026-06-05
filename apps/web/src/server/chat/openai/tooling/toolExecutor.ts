import type OpenAI from "openai";
import type { LangfuseObservation } from "@langfuse/tracing";
import {
  executeChatToolCall,
  type ExecutedChatToolCall,
} from "@/server/chat/openai/tooling/tools";

const sanitizeToolOutputForTelemetry = (
  output: string,
): string =>
  output.length <= 4_000
    ? output
    : `${output.slice(0, 4_000)}...`;

/**
 * Executes a single local tool call and returns both the serialized tool
 * output and the canonical metadata later used for route invalidation.
 *
 * This keeps the refresh contract grounded in the executed SQL/result pair
 * instead of in earlier streamed tool-call snapshots.
 */
export const runOneToolCall = async (
  params: Readonly<{
    item: OpenAI.Responses.ResponseFunctionToolCall;
    userId: string;
    workspaceId: string;
    rootObservation: LangfuseObservation | null;
  }>,
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
    const output = await executeChatToolCall(
      params.item.name,
      params.item.arguments,
      {
        userId: params.userId,
        workspaceId: params.workspaceId,
      },
    );
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
    toolObservation?.end();
    return output;
  } catch (error) {
    toolObservation?.updateOtelSpanAttributes({
      output: {
        error: error instanceof Error ? error.message : String(error),
      },
      metadata: {
        toolName: params.item.name,
        toolCallId: params.item.call_id,
        durationMs: String(Date.now() - startedAt),
      },
    });
    toolObservation?.end();
    throw error;
  }
};
