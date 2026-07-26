import { parseChatIdentifier } from "./chatSessionSummaryTransport";
import type { ChatTarget } from "./chatWorkspaceState";

const CHAT_SELECTION_STORAGE_PREFIX = "expense-tracker-chat-selection:v1:";

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

export const parseStoredChatTarget = (
  rawValue: string,
): ChatTarget => {
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

  if (value.kind === "draft") {
    return {
      kind: "draft",
      draftId: parseChatIdentifier(
        value.draftId,
        "Stored chat selection draftId",
      ),
    };
  }
  if (value.kind === "session") {
    return {
      kind: "session",
      sessionId: parseChatIdentifier(
        value.sessionId,
        "Stored chat selection sessionId",
      ),
    };
  }

  throw new Error("Stored chat selection kind must be draft or session");
};

export const readChatSelection = (
  storage: Storage,
  scope: ChatSelectionScope,
): ChatTarget | null => {
  const rawValue = storage.getItem(getChatSelectionStorageKey(scope));
  return rawValue === null ? null : parseStoredChatTarget(rawValue);
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
    JSON.stringify(validTarget),
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
