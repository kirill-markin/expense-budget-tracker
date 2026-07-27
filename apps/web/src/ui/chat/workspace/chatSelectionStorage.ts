import { parseChatIdentifier } from "./chatSessionSummaryTransport";
import type { ChatTarget } from "./chatWorkspaceState";

const CHAT_SELECTION_STORAGE_PREFIX = "expense-tracker-chat-selection:v1:";
const CHAT_ACTIVE_DRAFT_STORAGE_PREFIX =
  "expense-tracker-chat-active-draft:v1:";
const CHAT_SELECTION_STORAGE_PREFIXES = [
  CHAT_SELECTION_STORAGE_PREFIX,
  CHAT_ACTIVE_DRAFT_STORAGE_PREFIX,
] as const;

export type ChatSelectionScope =
  | Readonly<{
    mode: "demo";
    userId: string;
  }>
  | Readonly<{
    mode: "workspace";
    userId: string;
    workspaceId: string;
  }>;

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireStorageKeyPart = (
  value: string,
  context: string,
): string =>
  encodeURIComponent(parseChatIdentifier(value, context));

export const getChatSelectionStorageKey = (
  scope: ChatSelectionScope,
): string => {
  const userId = requireStorageKeyPart(
    scope.userId,
    "Chat selection scope userId",
  );
  if (scope.mode === "demo") {
    return `${CHAT_SELECTION_STORAGE_PREFIX}demo:${userId}`;
  }

  const workspaceId = requireStorageKeyPart(
    scope.workspaceId,
    "Chat selection scope workspaceId",
  );
  return `${CHAT_SELECTION_STORAGE_PREFIX}workspace:${userId}:${workspaceId}`;
};

export const getChatActiveDraftStorageKey = (
  scope: ChatSelectionScope,
): string => {
  const userId = requireStorageKeyPart(
    scope.userId,
    "Chat active draft scope userId",
  );
  if (scope.mode === "demo") {
    return `${CHAT_ACTIVE_DRAFT_STORAGE_PREFIX}demo:${userId}`;
  }

  const workspaceId = requireStorageKeyPart(
    scope.workspaceId,
    "Chat active draft scope workspaceId",
  );
  return `${CHAT_ACTIVE_DRAFT_STORAGE_PREFIX}workspace:${userId}:${workspaceId}`;
};

export const parseStoredChatTarget = (
  rawValue: string,
): ChatTarget | null => {
  let value: unknown;
  try {
    value = JSON.parse(rawValue) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Stored chat selection is not valid JSON: ${reason}`);
  }

  if (!isRecord(value)) {
    throw new Error("Stored chat selection must be an object");
  }

  let target: ChatTarget;
  if (value.kind === "draft") {
    target = {
      kind: "draft",
      draftId: parseChatIdentifier(
        value.draftId,
        "Stored chat selection draftId",
      ),
    };
  } else if (value.kind === "session") {
    target = {
      kind: "session",
      sessionId: parseChatIdentifier(
        value.sessionId,
        "Stored chat selection sessionId",
      ),
    };
  } else {
    throw new Error("Stored chat selection kind must be draft or session");
  }

  if (value.selectionReason === "explicit") {
    return target;
  }
  if (value.selectionReason === undefined) {
    return target.kind === "session" ? target : null;
  }

  throw new Error("Stored chat selection reason must be explicit");
};

export const readChatSelection = (
  storage: Storage,
  scope: ChatSelectionScope,
): ChatTarget | null => {
  const rawValue = storage.getItem(getChatSelectionStorageKey(scope));
  return rawValue === null ? null : parseStoredChatTarget(rawValue);
};

export const clearChatSelection = (
  storage: Storage,
  scope: ChatSelectionScope,
): void => {
  storage.removeItem(getChatSelectionStorageKey(scope));
};

export const readChatActiveDraftId = (
  storage: Storage,
  scope: ChatSelectionScope,
): string | null => {
  const draftId = storage.getItem(getChatActiveDraftStorageKey(scope));
  return draftId === null
    ? null
    : parseChatIdentifier(draftId, "Stored active chat draftId");
};

export const writeChatActiveDraftId = (
  storage: Storage,
  scope: ChatSelectionScope,
  draftId: string | null,
): void => {
  const storageKey = getChatActiveDraftStorageKey(scope);
  if (draftId === null) {
    storage.removeItem(storageKey);
    return;
  }

  storage.setItem(
    storageKey,
    parseChatIdentifier(draftId, "Chat active draftId"),
  );
};

export const clearChatSelectionState = (storage: Storage): void => {
  const storageKeys = Array.from(
    { length: storage.length },
    (_value: undefined, index: number): string | null => storage.key(index),
  ).filter((storageKey: string | null): storageKey is string =>
    storageKey !== null
    && CHAT_SELECTION_STORAGE_PREFIXES.some(
      (prefix: string): boolean => storageKey.startsWith(prefix),
    ));

  for (const storageKey of storageKeys) {
    storage.removeItem(storageKey);
  }
};

export const writeChatSelection = (
  storage: Storage,
  scope: ChatSelectionScope,
  target: ChatTarget,
): void => {
  const validTarget = target.kind === "draft"
    ? {
      kind: "draft" as const,
      draftId: parseChatIdentifier(
        target.draftId,
        "Chat selection draftId",
      ),
    }
    : {
      kind: "session" as const,
      sessionId: parseChatIdentifier(
        target.sessionId,
        "Chat selection sessionId",
      ),
    };

  storage.setItem(
    getChatSelectionStorageKey(scope),
    JSON.stringify({
      ...validTarget,
      selectionReason: "explicit",
    }),
  );
};

export const readChatSessionTargetFromSearchParams = (
  searchParams: URLSearchParams,
): ChatTarget | null => {
  const sessionValues = searchParams.getAll("session");
  if (sessionValues.length === 0) {
    return null;
  }
  if (sessionValues.length !== 1) {
    throw new Error("Chat URL must contain at most one session query parameter");
  }

  return {
    kind: "session",
    sessionId: parseChatIdentifier(
      sessionValues[0],
      "Chat URL session query parameter",
    ),
  };
};

export const buildChatTargetUrl = (
  target: ChatTarget,
): string => {
  if (target.kind === "draft") {
    parseChatIdentifier(target.draftId, "Chat draft target draftId");
    return "/chat";
  }

  const sessionId = parseChatIdentifier(
    target.sessionId,
    "Chat session target sessionId",
  );
  const searchParams = new URLSearchParams({ session: sessionId });
  return `/chat?${searchParams.toString()}`;
};
