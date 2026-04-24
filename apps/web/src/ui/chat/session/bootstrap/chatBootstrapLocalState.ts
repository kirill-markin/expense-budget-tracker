import type { StoredMessage } from "@/ui/hooks/useChatHistory";
import type { ChatRunState } from "../../stream/streamRecovery";

const CHAT_LOCAL_STATE_STORAGE_PREFIX = "expense-tracker-chat-local-state:";
export const CHAT_LOCAL_STATE_VERSION = 1;
export const CHAT_LOCAL_STATE_STALE_MS = 6 * 60 * 60 * 1000;

export type ChatBootstrapLocalState = Readonly<{
  version: number;
  sessionId: string | null;
  lastUserMessageAt: number | null;
  lastKnownRunState: ChatRunState;
  lastSnapshotUpdatedAt: number | null;
}>;

export type ChatBootstrapMode =
  | Readonly<{ kind: "server" }>
  | Readonly<{ kind: "local_empty"; sessionId: string | null }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isChatRunState = (value: unknown): value is ChatRunState =>
  value === "idle" || value === "running" || value === "interrupted";

const parseSessionId = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();
  return normalizedValue === "" ? undefined : normalizedValue;
};

const parseOptionalTimestamp = (value: unknown): number | null | undefined => {
  if (value === null) {
    return null;
  }

  return isFiniteTimestamp(value) ? value : undefined;
};

const getStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const getChatBootstrapLocalStateStorageKey = (
  workspaceId: string,
): string => `${CHAT_LOCAL_STATE_STORAGE_PREFIX}${workspaceId}`;

export const deriveLastUserMessageAt = (
  messages: ReadonlyArray<StoredMessage>,
): number | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message.timestamp;
    }
  }

  return null;
};

export const createChatBootstrapLocalState = (
  sessionId: string | null,
  lastUserMessageAt: number | null,
  lastKnownRunState: ChatRunState,
  lastSnapshotUpdatedAt: number | null,
): ChatBootstrapLocalState => ({
  version: CHAT_LOCAL_STATE_VERSION,
  sessionId,
  lastUserMessageAt,
  lastKnownRunState,
  lastSnapshotUpdatedAt,
});

export const parseChatBootstrapLocalState = (
  rawValue: string,
): ChatBootstrapLocalState | null => {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawValue);
  } catch {
    return null;
  }

  if (!isRecord(parsedValue) || parsedValue.version !== CHAT_LOCAL_STATE_VERSION) {
    return null;
  }

  const sessionId = parseSessionId(parsedValue.sessionId);
  const lastUserMessageAt = parseOptionalTimestamp(parsedValue.lastUserMessageAt);
  const lastSnapshotUpdatedAt = parseOptionalTimestamp(parsedValue.lastSnapshotUpdatedAt);

  if (
    sessionId === undefined
    || lastUserMessageAt === undefined
    || lastSnapshotUpdatedAt === undefined
    || !isChatRunState(parsedValue.lastKnownRunState)
  ) {
    return null;
  }

  if (sessionId === null && parsedValue.lastKnownRunState !== "idle") {
    return null;
  }

  return createChatBootstrapLocalState(
    sessionId,
    lastUserMessageAt,
    parsedValue.lastKnownRunState,
    lastSnapshotUpdatedAt,
  );
};

export const readChatBootstrapLocalState = (
  workspaceId: string,
): ChatBootstrapLocalState | null => {
  const storage = getStorage();
  if (storage === null) {
    return null;
  }

  try {
    const rawValue = storage.getItem(getChatBootstrapLocalStateStorageKey(workspaceId));
    return rawValue === null ? null : parseChatBootstrapLocalState(rawValue);
  } catch {
    return null;
  }
};

export const writeChatBootstrapLocalState = (
  workspaceId: string,
  state: ChatBootstrapLocalState,
): void => {
  const storage = getStorage();
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(
      getChatBootstrapLocalStateStorageKey(workspaceId),
      JSON.stringify(state),
    );
  } catch {
    // Ignore local storage write failures and fall back to server bootstrap.
  }
};

export const readChatBootstrapLocalStateFromStorageEvent = (
  workspaceId: string,
  key: string | null,
  newValue: string | null,
): ChatBootstrapLocalState | null | undefined => {
  if (key !== getChatBootstrapLocalStateStorageKey(workspaceId)) {
    return undefined;
  }

  return newValue === null ? null : parseChatBootstrapLocalState(newValue);
};

export const resolveChatBootstrapMode = (
  state: ChatBootstrapLocalState | null,
  now: number,
): ChatBootstrapMode => {
  if (state === null || state.lastKnownRunState !== "idle") {
    return { kind: "server" };
  }

  if (state.lastUserMessageAt === null) {
    if (state.sessionId !== null) {
      return { kind: "server" };
    }

    return {
      kind: "local_empty",
      sessionId: state.sessionId,
    };
  }

  if (now - state.lastUserMessageAt > CHAT_LOCAL_STATE_STALE_MS) {
    return {
      kind: "local_empty",
      sessionId: null,
    };
  }

  return { kind: "server" };
};
