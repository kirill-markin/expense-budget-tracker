const CHAT_DRAFT_STORAGE_PREFIX = "expense-tracker-chat-draft:v1:";

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

export const getChatDraftStorageKey = (scope: ChatDraftScope): string => {
  const userId = requireStorageKeyPart("userId", scope.userId);
  if (scope.mode === "demo") {
    return `${CHAT_DRAFT_STORAGE_PREFIX}demo:${userId}`;
  }

  const workspaceId = requireStorageKeyPart("workspaceId", scope.workspaceId);
  return `${CHAT_DRAFT_STORAGE_PREFIX}workspace:${userId}:${workspaceId}`;
};

export const readChatDraft = (
  storage: Storage,
  scope: ChatDraftScope,
): string => storage.getItem(getChatDraftStorageKey(scope)) ?? "";

export const writeChatDraft = (
  storage: Storage,
  scope: ChatDraftScope,
  text: string,
): void => {
  const storageKey = getChatDraftStorageKey(scope);
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
    storageKey !== null && storageKey.startsWith(CHAT_DRAFT_STORAGE_PREFIX));

  for (const storageKey of draftStorageKeys) {
    storage.removeItem(storageKey);
  }
};
