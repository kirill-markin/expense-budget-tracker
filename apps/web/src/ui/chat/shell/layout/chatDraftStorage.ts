import { getChatTargetKey, type ChatTarget } from "../../workspace/chatWorkspaceState";

const LEGACY_CHAT_DRAFT_STORAGE_PREFIX = "expense-tracker-chat-draft:v1:";
const CHAT_DRAFT_STORAGE_PREFIX = "expense-tracker-chat-draft:v2:";
const CHAT_DRAFT_STORAGE_PREFIXES = [
  LEGACY_CHAT_DRAFT_STORAGE_PREFIX,
  CHAT_DRAFT_STORAGE_PREFIX,
] as const;

export type ChatDraftScope =
  | Readonly<{
      mode: "demo";
      userId: string;
    }>
  | Readonly<{
      mode: "workspace";
      userId: string;
      workspaceId: string;
    }>;

const requireStorageKeyPart = (name: string, value: string): string => {
  if (value.trim() === "") {
    throw new Error(`Cannot persist a chat draft with an empty ${name}`);
  }

  return encodeURIComponent(value);
};

const getLegacyChatDraftStorageKey = (
  scope: ChatDraftScope,
): string => {
  const userId = requireStorageKeyPart("userId", scope.userId);
  if (scope.mode === "demo") {
    return `${LEGACY_CHAT_DRAFT_STORAGE_PREFIX}demo:${userId}`;
  }

  const workspaceId = requireStorageKeyPart("workspaceId", scope.workspaceId);
  return `${LEGACY_CHAT_DRAFT_STORAGE_PREFIX}workspace:${userId}:${workspaceId}`;
};

export const getChatDraftStorageKey = (
  scope: ChatDraftScope,
  target: ChatTarget,
): string => {
  const userId = requireStorageKeyPart("userId", scope.userId);
  const targetKey = requireStorageKeyPart("target", getChatTargetKey(target));
  if (scope.mode === "demo") {
    return `${CHAT_DRAFT_STORAGE_PREFIX}demo:${userId}:${targetKey}`;
  }

  const workspaceId = requireStorageKeyPart("workspaceId", scope.workspaceId);
  return `${CHAT_DRAFT_STORAGE_PREFIX}workspace:${userId}:${workspaceId}:${targetKey}`;
};

export const readAndMigrateChatDraft = (
  storage: Storage,
  scope: ChatDraftScope,
  target: ChatTarget,
): string => {
  const storageKey = getChatDraftStorageKey(scope, target);
  const currentDraft = storage.getItem(storageKey);
  const legacyStorageKey = getLegacyChatDraftStorageKey(scope);
  const legacyDraft = storage.getItem(legacyStorageKey);
  if (currentDraft !== null) {
    storage.removeItem(legacyStorageKey);
    return currentDraft;
  }
  if (legacyDraft === null) {
    return "";
  }

  if (legacyDraft !== "") {
    storage.setItem(storageKey, legacyDraft);
  }
  storage.removeItem(legacyStorageKey);
  return legacyDraft;
};

export const writeChatDraft = (
  storage: Storage,
  scope: ChatDraftScope,
  target: ChatTarget,
  text: string,
): void => {
  const storageKey = getChatDraftStorageKey(scope, target);
  if (text === "") {
    storage.removeItem(storageKey);
    return;
  }

  storage.setItem(storageKey, text);
};

export const clearChatDrafts = (storage: Storage): void => {
  const draftStorageKeys = Array.from(
    { length: storage.length },
    (_value: undefined, index: number): string | null => storage.key(index),
  ).filter((storageKey: string | null): storageKey is string =>
    storageKey !== null
    && CHAT_DRAFT_STORAGE_PREFIXES.some(
      (prefix: string): boolean => storageKey.startsWith(prefix),
    ));

  for (const storageKey of draftStorageKeys) {
    storage.removeItem(storageKey);
  }
};
