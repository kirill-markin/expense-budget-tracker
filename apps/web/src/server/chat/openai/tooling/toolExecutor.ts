import type OpenAI from "openai";
import {
  executeChatToolCall,
  type ExecutedChatToolCall,
} from "@/server/chat/openai/tooling/tools";
import { log } from "@/server/logger";
import {
  runInToolCallSpan,
  setToolCallErrorCode,
  setToolCallResultAttributes,
} from "@/server/telemetry/chatSpans";

type ToolExecutorParams = Readonly<{
  item: OpenAI.Responses.ResponseFunctionToolCall;
  requestId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  /**
   * Captured when the request arrived and carried down with the run, because a
   * persisted run outlives its request and the file tools have to refuse in
   * demo mode rather than fail against a database that is not there.
   */
  isDemoMode: boolean;
}>;

const THROWN_TOOL_ERROR_CODE = "internal_error";

type ToolExecutorDependencies = Readonly<{
  executeChatToolCall: typeof executeChatToolCall;
  log: typeof log;
}>;

const DEFAULT_TOOL_EXECUTOR_DEPENDENCIES: ToolExecutorDependencies = {
  executeChatToolCall,
  log,
};

type ToolCallOutcome = Readonly<{
  status: "completed" | "error";
  errorCode: string | null;
}>;

/**
 * The single CloudWatch record for an executed chat tool call, emitted once per
 * call next to the span it mirrors. The recorded workspace is the session's,
 * which every call has; the result's own workspace stays reserved for the
 * route-refresh gate.
 */
const logToolCallRecord = (
  params: ToolExecutorParams,
  outcome: ToolCallOutcome,
  durationMs: number,
  logger: typeof log,
): void => {
  logger({
    domain: "chat",
    action: "tool_call",
    vendor: "openai",
    tool: params.item.name,
    status: outcome.status,
    durationMs,
    errorCode: outcome.errorCode,
    requestId: params.requestId,
    userId: params.userId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
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
): Promise<ExecutedChatToolCall> =>
  runInToolCallSpan(
    {
      requestId: params.requestId,
      userId: params.userId,
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      toolName: params.item.name,
      toolCallId: params.item.call_id,
    },
    async (span): Promise<ExecutedChatToolCall> => {
      const startedAt = Date.now();
      let output: ExecutedChatToolCall;
      try {
        output = await dependencies.executeChatToolCall(
          params.item.name,
          params.item.arguments,
          {
            requestId: params.requestId,
            userId: params.userId,
            workspaceId: params.workspaceId,
            sessionId: params.sessionId,
            turnId: params.turnId,
            toolCallId: params.item.call_id,
            isDemoMode: params.isDemoMode,
          },
        );
      } catch (error) {
        // Today only an unsupported tool name throws here, and the MCP surface
        // answers an unhandled error with the same code.
        setToolCallErrorCode(span, THROWN_TOOL_ERROR_CODE);
        logToolCallRecord(
          params,
          { status: "error", errorCode: THROWN_TOOL_ERROR_CODE },
          Date.now() - startedAt,
          dependencies.log,
        );
        throw error;
      }

      setToolCallResultAttributes(span, output);
      logToolCallRecord(
        params,
        output.succeeded
          ? { status: "completed", errorCode: null }
          : { status: "error", errorCode: output.errorCode },
        Date.now() - startedAt,
        dependencies.log,
      );
      return output;
    },
  );

export const runOneToolCall = async (
  params: Parameters<typeof runOneToolCallWithDependencies>[0],
): Promise<ExecutedChatToolCall> =>
  runOneToolCallWithDependencies(
    params,
    DEFAULT_TOOL_EXECUTOR_DEPENDENCIES,
  );
