import type { ChatStreamEvent } from "@/server/chat/types";

export const INTERRUPTED_TOOL_CALL_OUTPUT = "Interrupted before output was captured.";

export type FunctionToolCallRawItem = Readonly<{
  type: "function_call";
  callId: string;
  id?: string;
  name: string;
  arguments?: string;
  status?: string;
}>;

export type ToolCallOutputRawItem = Readonly<{
  type: string;
  callId?: string;
  id?: string;
  name?: string;
}>;

export type ToolCallPosition = Readonly<{
  itemId: string;
  responseIndex: number;
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

const TERMINAL_TOOL_PROVIDER_STATUSES = new Set(["completed", "failed", "incomplete"]);

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
  responseIndex: number,
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
  responseIndex,
  outputIndex,
  sequenceNumber,
  ...(providerStatus !== null ? { providerStatus } : {}),
  ...(input !== null ? { input } : {}),
  ...(output !== null ? { output } : {}),
  ...(refreshRoute ? { refreshRoute: true } : {}),
});

export const getRequiredToolCallId = (
  rawItem: FunctionToolCallRawItem | ToolCallOutputRawItem,
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
  rawItem: FunctionToolCallRawItem | ToolCallOutputRawItem,
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
    position.responseIndex,
    position.outputIndex,
    position.sequenceNumber,
    providerStatus,
    rawItem.arguments ?? null,
    null,
    false,
  );
};

/**
 * Builds the completed tool-call event emitted after local execution.
 *
 * The `refreshRoute` flag is passed in from canonical execution metadata
 * produced by `executeChatToolCall`. This avoids the older failure mode where
 * the runtime tried to infer route refresh eligibility from transient streamed
 * tool snapshots instead of from the SQL that actually ran.
 */
const buildToolOutputEvent = (
  rawItem: ToolCallOutputRawItem,
  previousSnapshot: ToolCallEvent | null,
  rawOutput: unknown,
  refreshRoute: boolean,
): ToolCallEvent => {
  const id = getRequiredToolCallId(rawItem);
  const output = stringifyToolValue(rawOutput);
  const name = previousSnapshot?.name ?? (typeof rawItem.name === "string" ? rawItem.name : "tool");
  return createToolCallEvent(
    id,
    getRequiredToolItemId(rawItem, previousSnapshot),
    name,
    "completed",
    previousSnapshot?.responseIndex ?? 0,
    getRequiredToolOutputIndex(previousSnapshot, rawItem),
    previousSnapshot?.sequenceNumber ?? null,
    "completed",
    previousSnapshot?.input ?? null,
    output,
    refreshRoute,
  );
};

const areToolCallEventsEqual = (
  left: ToolCallEvent,
  right: ToolCallEvent,
): boolean =>
  left.id === right.id
  && left.itemId === right.itemId
  && left.name === right.name
  && left.status === right.status
  && left.responseIndex === right.responseIndex
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
    nextSnapshot.responseIndex ?? previousSnapshot.responseIndex ?? 0,
    previousSnapshot.outputIndex,
    nextSnapshot.sequenceNumber ?? previousSnapshot.sequenceNumber,
    nextSnapshot.providerStatus ?? previousSnapshot.providerStatus ?? null,
    nextSnapshot.input ?? previousSnapshot.input ?? null,
    nextSnapshot.output ?? previousSnapshot.output ?? null,
    nextSnapshot.refreshRoute === true || previousSnapshot.refreshRoute === true,
  );

export const createToolCallStateMap = (): ToolCallStateMap => new Map();

export const applyToolCallStarted = (
  toolStates: ToolCallStateMap,
  rawItem: FunctionToolCallRawItem,
  position: ToolCallPosition,
  nowMs: number,
): ToolCallUpdate => {
  const rawSnapshot = buildFunctionToolCallEvent(rawItem, position);
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
    previousState.snapshot.responseIndex ?? 0,
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
    previousState.snapshot.responseIndex ?? 0,
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

/**
 * Applies the terminal output of one tool call to the tracked local tool
 * state.
 *
 * Completed transcript state and route refresh eligibility intentionally travel
 * together here: the event becomes `completed`, but route invalidation is only
 * marked when the caller provides `refreshRoute === true` from canonical tool
 * execution metadata.
 */
export const applyToolCallOutput = (
  toolStates: ToolCallStateMap,
  rawItem: ToolCallOutputRawItem,
  rawOutput: unknown,
  nowMs: number,
  refreshRoute: boolean,
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
    refreshRoute,
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
