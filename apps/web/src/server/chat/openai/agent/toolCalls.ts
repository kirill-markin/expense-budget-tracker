import type { ChatStreamEvent } from "@/server/chat/types";

type QueryDatabaseToolOutput = Readonly<{
  statements?: ReadonlyArray<Readonly<{
    command?: unknown;
  }>>;
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

const setToolCallState = (
  toolStates: ToolCallStateMap,
  event: ToolCallEvent,
  startedAt: number,
): ToolCallStateMap => {
  const nextToolStates = new Map(toolStates);
  nextToolStates.set(event.id, { snapshot: event, startedAt });
  return nextToolStates;
};

export const createToolCallStateMap = (): ToolCallStateMap => new Map();

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

export const applyToolCallStarted = (
  toolStates: ToolCallStateMap,
  rawItem: FunctionToolCallRawItem | HostedToolCallRawItem,
  nowMs: number,
): ToolCallUpdate => {
  const snapshot = rawItem.type === "hosted_tool_call"
    ? buildHostedToolCallEvent(rawItem)
    : buildFunctionToolCallEvent(rawItem);
  const previousState = toolStates.get(snapshot.id);
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

export const applyToolCallOutput = (
  toolStates: ToolCallStateMap,
  rawItem: ToolCallOutputRawItem,
  rawOutput: unknown,
  nowMs: number,
): ToolCallUpdate => {
  const snapshotId = getRequiredToolCallId(rawItem);
  const previousState = toolStates.get(snapshotId);
  const snapshot = buildToolOutputEvent(
    rawItem,
    previousState?.snapshot ?? null,
    rawOutput,
  );
  const startedAt = previousState?.startedAt ?? nowMs;
  const nextToolStates = setToolCallState(toolStates, snapshot, startedAt);
  const isCompleted = previousState?.snapshot.status !== "completed";

  return {
    toolStates: nextToolStates,
    event: previousState === undefined || !areToolCallEventsEqual(previousState.snapshot, snapshot)
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
