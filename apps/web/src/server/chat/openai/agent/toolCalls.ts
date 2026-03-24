import { isExpenseSqlMutation } from "@expense-budget-tracker/agent-shared/sql-policy";
import type { ChatStreamEvent } from "@/server/chat/types";

export const INTERRUPTED_TOOL_CALL_OUTPUT = "Interrupted before output was captured.";

type QueryDatabaseToolInput = Readonly<{
  sql?: unknown;
}>;

export type FunctionToolCallRawItem = Readonly<{
  type: "function_call";
  callId: string;
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
}>;

export type HostedToolCallRawItem = Readonly<{
  type: "hosted_tool_call";
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
  output?: string;
  providerData?: Readonly<Record<string, unknown>>;
}>;

export type ToolCallOutputRawItem = Readonly<{
  type: string;
  callId?: string;
  id?: string;
  name?: string;
}>;

export type ToolCallPosition = Readonly<{
  itemId: string;
  outputIndex: number;
  sequenceNumber: number | null;
}>;

export type FunctionCallArgumentsDeltaEvent = Readonly<{
  itemId: string;
  outputIndex: number;
  sequenceNumber: number;
  delta: string;
}>;

export type FunctionCallArgumentsDoneEvent = Readonly<{
  itemId: string;
  outputIndex: number;
  sequenceNumber: number;
  arguments: string;
}>;

export type ToolCallEvent = Extract<ChatStreamEvent, { type: "tool_call" }>;

type ToolCallState = Readonly<{
  snapshot: ToolCallEvent;
  startedAt: number;
}>;

export type ToolCallStateMap = ReadonlyMap<string, ToolCallState>;

type ToolCallUpdate = Readonly<{
  toolStates: ToolCallStateMap;
  event: ToolCallEvent | null;
  started: boolean;
  completed: boolean;
  durationMs: number | null;
}>;

type FinalizedToolCall = Readonly<{
  event: ToolCallEvent;
  durationMs: number;
}>;

type FinalizeToolCallUpdates = Readonly<{
  toolStates: ToolCallStateMap;
  finalized: ReadonlyArray<FinalizedToolCall>;
}>;

const TERMINAL_TOOL_PROVIDER_STATUSES = new Set(["completed", "failed", "incomplete"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  itemId: string,
  name: string,
  status: ToolCallEvent["status"],
  outputIndex: number,
  sequenceNumber: number | null,
  providerStatus: string | null,
  input: string | null,
  output: string | null,
  refreshRoute: boolean,
): ToolCallEvent => ({
  type: "tool_call",
  id,
  itemId,
  name,
  status,
  outputIndex,
  sequenceNumber,
  ...(providerStatus !== null ? { providerStatus } : {}),
  ...(input !== null ? { input } : {}),
  ...(output !== null ? { output } : {}),
  ...(refreshRoute ? { refreshRoute: true } : {}),
});

export const getRequiredToolCallId = (
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

const getRequiredToolItemId = (
  rawItem: FunctionToolCallRawItem | HostedToolCallRawItem | ToolCallOutputRawItem,
  previousSnapshot: ToolCallEvent | null,
): string => {
  if (typeof rawItem.id === "string" && rawItem.id.length > 0) {
    return rawItem.id;
  }
  if (previousSnapshot !== null) {
    return previousSnapshot.itemId;
  }
  throw new Error(`OpenAI tool call is missing an output item id: ${JSON.stringify(rawItem)}`);
};

const getRequiredToolOutputIndex = (
  previousSnapshot: ToolCallEvent | null,
  rawItem: ToolCallOutputRawItem,
): number => {
  if (previousSnapshot !== null) {
    return previousSnapshot.outputIndex;
  }
  throw new Error(`OpenAI tool call output arrived before a tracked output item existed: ${JSON.stringify(rawItem)}`);
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
  position: ToolCallPosition,
): ToolCallEvent => {
  const providerStatus = typeof rawItem.status === "string" ? rawItem.status : null;
  return createToolCallEvent(
    getRequiredToolCallId(rawItem),
    position.itemId,
    rawItem.name,
    isTerminalToolProviderStatus(providerStatus) ? "completed" : "started",
    position.outputIndex,
    position.sequenceNumber,
    providerStatus,
    getHostedToolCallInput(rawItem),
    getHostedToolCallOutput(rawItem),
    false,
  );
};

const buildFunctionToolCallEvent = (
  rawItem: FunctionToolCallRawItem,
  position: ToolCallPosition,
): ToolCallEvent => {
  const providerStatus = typeof rawItem.status === "string" ? rawItem.status : null;
  return createToolCallEvent(
    getRequiredToolCallId(rawItem),
    position.itemId,
    rawItem.name,
    isTerminalToolProviderStatus(providerStatus) ? "completed" : "started",
    position.outputIndex,
    position.sequenceNumber,
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
  const refreshRoute = shouldRefreshRouteAfterToolCall(name, previousSnapshot?.input ?? null);
  return createToolCallEvent(
    id,
    getRequiredToolItemId(rawItem, previousSnapshot),
    name,
    "completed",
    getRequiredToolOutputIndex(previousSnapshot, rawItem),
    previousSnapshot?.sequenceNumber ?? null,
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
    event.itemId,
    event.name,
    "completed",
    event.outputIndex,
    event.sequenceNumber,
    isTerminalToolProviderStatus(event.providerStatus) ? (event.providerStatus ?? null) : "completed",
    event.input ?? null,
    event.output ?? INTERRUPTED_TOOL_CALL_OUTPUT,
    event.refreshRoute === true,
  );

const areToolCallEventsEqual = (
  left: ToolCallEvent,
  right: ToolCallEvent,
): boolean =>
  left.id === right.id
  && left.itemId === right.itemId
  && left.name === right.name
  && left.status === right.status
  && left.outputIndex === right.outputIndex
  && left.sequenceNumber === right.sequenceNumber
  && left.providerStatus === right.providerStatus
  && left.input === right.input
  && left.output === right.output
  && left.refreshRoute === right.refreshRoute;

const setToolCallState = (
  toolStates: ToolCallStateMap,
  event: ToolCallEvent,
  startedAt: number,
): ToolCallStateMap => {
  const nextToolStates = new Map(toolStates);
  nextToolStates.set(event.id, { snapshot: event, startedAt });
  return nextToolStates;
};

const findToolStateByItemId = (
  toolStates: ToolCallStateMap,
  itemId: string,
): ToolCallState | null => {
  for (const state of toolStates.values()) {
    if (state.snapshot.itemId === itemId) {
      return state;
    }
  }

  return null;
};

const mergeToolCallSnapshot = (
  previousSnapshot: ToolCallEvent,
  nextSnapshot: ToolCallEvent,
): ToolCallEvent =>
  createToolCallEvent(
    nextSnapshot.id,
    previousSnapshot.itemId,
    nextSnapshot.name,
    nextSnapshot.status,
    previousSnapshot.outputIndex,
    nextSnapshot.sequenceNumber ?? previousSnapshot.sequenceNumber,
    nextSnapshot.providerStatus ?? previousSnapshot.providerStatus ?? null,
    nextSnapshot.input ?? previousSnapshot.input ?? null,
    nextSnapshot.output ?? previousSnapshot.output ?? null,
    nextSnapshot.refreshRoute === true || previousSnapshot.refreshRoute === true,
  );

export const createToolCallStateMap = (): ToolCallStateMap => new Map();

export const getTrackedToolCallPosition = (
  toolStates: ToolCallStateMap,
  toolId: string,
): ToolCallPosition | null => {
  const state = toolStates.get(toolId);
  if (state === undefined) {
    return null;
  }

  return {
    itemId: state.snapshot.itemId,
    outputIndex: state.snapshot.outputIndex,
    sequenceNumber: state.snapshot.sequenceNumber,
  };
};

/**
 * Determines whether a completed tool call should invalidate the route-backed
 * main content shown beside the sidebar chat.
 *
 * The decision is based on the shared SQL policy used to validate the original
 * `query_database` input, not on PostgreSQL command tags. Command tags are
 * insufficient for data-modifying CTEs such as `WITH changed AS (UPDATE ...)
 * SELECT ...`, which mutate data while still reporting `SELECT`.
 */
export const shouldRefreshRouteAfterToolCall = (
  name: string,
  input: string | null,
): boolean => {
  if (name !== "query_database" || input === null) {
    return false;
  }

  try {
    const parsed = JSON.parse(input) as QueryDatabaseToolInput;
    if (typeof parsed.sql !== "string") {
      return false;
    }

    return isExpenseSqlMutation(parsed.sql);
  } catch {
    return false;
  }
};

export const applyToolCallStarted = (
  toolStates: ToolCallStateMap,
  rawItem: FunctionToolCallRawItem | HostedToolCallRawItem,
  position: ToolCallPosition,
  nowMs: number,
): ToolCallUpdate => {
  const rawSnapshot = rawItem.type === "hosted_tool_call"
    ? buildHostedToolCallEvent(rawItem, position)
    : buildFunctionToolCallEvent(rawItem, position);
  const previousState = toolStates.get(rawSnapshot.id);
  const snapshot = previousState === undefined
    ? rawSnapshot
    : mergeToolCallSnapshot(previousState.snapshot, rawSnapshot);
  const startedAt = previousState?.startedAt ?? nowMs;
  const nextToolStates = setToolCallState(toolStates, snapshot, startedAt);
  const isStarted = previousState === undefined && snapshot.status === "started";
  const isCompleted = snapshot.status === "completed" && previousState?.snapshot.status !== "completed";

  return {
    toolStates: nextToolStates,
    event: previousState === undefined || !areToolCallEventsEqual(previousState.snapshot, snapshot)
      ? snapshot
      : null,
    started: isStarted,
    completed: isCompleted,
    durationMs: isCompleted ? nowMs - startedAt : null,
  };
};

export const applyFunctionCallArgumentsDelta = (
  toolStates: ToolCallStateMap,
  event: FunctionCallArgumentsDeltaEvent,
): ToolCallUpdate => {
  const previousState = findToolStateByItemId(toolStates, event.itemId);
  if (previousState === null) {
    throw new Error(
      `OpenAI function_call_arguments.delta arrived before response.output_item.added for item_id=${event.itemId} output_index=${String(event.outputIndex)}`,
    );
  }
  if (previousState.snapshot.outputIndex !== event.outputIndex) {
    throw new Error(
      `OpenAI function_call_arguments.delta changed output_index for item_id=${event.itemId} from ${String(previousState.snapshot.outputIndex)} to ${String(event.outputIndex)}`,
    );
  }

  const nextSnapshot: ToolCallEvent = createToolCallEvent(
    previousState.snapshot.id,
    previousState.snapshot.itemId,
    previousState.snapshot.name,
    previousState.snapshot.status,
    previousState.snapshot.outputIndex,
    event.sequenceNumber,
    previousState.snapshot.providerStatus ?? null,
    (previousState.snapshot.input ?? "") + event.delta,
    previousState.snapshot.output ?? null,
    previousState.snapshot.refreshRoute === true,
  );
  const nextToolStates = setToolCallState(toolStates, nextSnapshot, previousState.startedAt);

  return {
    toolStates: nextToolStates,
    event: areToolCallEventsEqual(previousState.snapshot, nextSnapshot) ? null : nextSnapshot,
    started: false,
    completed: false,
    durationMs: null,
  };
};

export const applyFunctionCallArgumentsDone = (
  toolStates: ToolCallStateMap,
  event: FunctionCallArgumentsDoneEvent,
): ToolCallUpdate => {
  const previousState = findToolStateByItemId(toolStates, event.itemId);
  if (previousState === null) {
    throw new Error(
      `OpenAI function_call_arguments.done arrived before response.output_item.added for item_id=${event.itemId} output_index=${String(event.outputIndex)}`,
    );
  }
  if (previousState.snapshot.outputIndex !== event.outputIndex) {
    throw new Error(
      `OpenAI function_call_arguments.done changed output_index for item_id=${event.itemId} from ${String(previousState.snapshot.outputIndex)} to ${String(event.outputIndex)}`,
    );
  }

  const nextSnapshot: ToolCallEvent = createToolCallEvent(
    previousState.snapshot.id,
    previousState.snapshot.itemId,
    previousState.snapshot.name,
    previousState.snapshot.status,
    previousState.snapshot.outputIndex,
    event.sequenceNumber,
    previousState.snapshot.providerStatus ?? null,
    event.arguments,
    previousState.snapshot.output ?? null,
    previousState.snapshot.refreshRoute === true,
  );
  const nextToolStates = setToolCallState(toolStates, nextSnapshot, previousState.startedAt);

  return {
    toolStates: nextToolStates,
    event: areToolCallEventsEqual(previousState.snapshot, nextSnapshot) ? null : nextSnapshot,
    started: false,
    completed: false,
    durationMs: null,
  };
};

export const applyToolCallOutput = (
  toolStates: ToolCallStateMap,
  rawItem: ToolCallOutputRawItem,
  rawOutput: unknown,
  nowMs: number,
): ToolCallUpdate => {
  const snapshotId = getRequiredToolCallId(rawItem);
  const previousState = toolStates.get(snapshotId);
  if (previousState === undefined) {
    throw new Error(
      `OpenAI tool call output arrived before a tracked output item existed: ${JSON.stringify(rawItem)}`,
    );
  }
  const snapshot = buildToolOutputEvent(
    rawItem,
    previousState.snapshot,
    rawOutput,
  );
  const startedAt = previousState.startedAt;
  const nextToolStates = setToolCallState(toolStates, snapshot, startedAt);
  const isCompleted = previousState.snapshot.status !== "completed";

  return {
    toolStates: nextToolStates,
    event: !areToolCallEventsEqual(previousState.snapshot, snapshot)
      ? snapshot
      : null,
    started: false,
    completed: isCompleted,
    durationMs: isCompleted ? nowMs - startedAt : null,
  };
};

export const finalizePendingToolCalls = (
  toolStates: ToolCallStateMap,
  nowMs: number,
): FinalizeToolCallUpdates => {
  let nextToolStates: ToolCallStateMap = toolStates;
  const finalized: Array<FinalizedToolCall> = [];

  for (const state of toolStates.values()) {
    if (state.snapshot.status === "completed") {
      continue;
    }

    const snapshot = finalizeToolCallEvent(state.snapshot);
    nextToolStates = setToolCallState(nextToolStates, snapshot, state.startedAt);
    finalized.push({
      event: snapshot,
      durationMs: nowMs - state.startedAt,
    });
  }

  return {
    toolStates: nextToolStates,
    finalized,
  };
};
