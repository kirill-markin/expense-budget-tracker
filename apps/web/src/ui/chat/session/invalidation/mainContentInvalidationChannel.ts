"use client";

export type MainContentInvalidationMessage = Readonly<{
  type: "main_content_invalidation";
  workspaceId: string;
  version: number;
  sourceId: string;
  emittedAt: number;
}>;

export type MainContentInvalidationSubscription = Readonly<{
  unsubscribe: () => void;
}>;

type MainContentInvalidationTarget = Readonly<{
  workspaceId: string;
  sourceId: string;
  seenMessageKeys: ReadonlySet<string>;
}>;

type MainContentInvalidationPublishParams = Readonly<{
  workspaceId: string;
  version: number;
  sourceId: string;
  emittedAt: number;
}>;

type MainContentInvalidationSubscribeParams = Readonly<{
  workspaceId: string;
  sourceId: string;
  seenMessageKeys: ReadonlySet<string>;
  onMessage: (message: MainContentInvalidationMessage) => void;
}>;

const CHANNEL_NAME = "expense-tracker-main-content-invalidation";
const STORAGE_KEY = "expense-tracker-main-content-invalidation";

let browserSourceId: string | null = null;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isFiniteNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isString = (value: unknown): value is string =>
  typeof value === "string";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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

const createBrowserSourceId = (): string => {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Browser crypto.randomUUID is unavailable for main content invalidation");
  }

  return crypto.randomUUID();
};

const parseStoredMessage = (rawValue: string): unknown => {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }
};

export const getMainContentInvalidationSourceId = (): string => {
  if (browserSourceId === null) {
    browserSourceId = createBrowserSourceId();
  }

  return browserSourceId;
};

export const parseMainContentInvalidationMessage = (
  value: unknown,
): MainContentInvalidationMessage | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    value.type !== "main_content_invalidation"
    || !isString(value.workspaceId)
    || !isNonNegativeInteger(value.version)
    || !isNonEmptyString(value.sourceId)
    || !isFiniteNonNegativeNumber(value.emittedAt)
  ) {
    return null;
  }

  return {
    type: "main_content_invalidation",
    workspaceId: value.workspaceId,
    version: value.version,
    sourceId: value.sourceId,
    emittedAt: value.emittedAt,
  };
};

export const getMainContentInvalidationMessageKey = (
  message: MainContentInvalidationMessage,
): string =>
  `${message.sourceId}:${message.version}:${message.emittedAt}`;

export const getAcceptedMainContentInvalidationMessage = (
  value: unknown,
  target: MainContentInvalidationTarget,
): MainContentInvalidationMessage | null => {
  const message = parseMainContentInvalidationMessage(value);
  if (message === null) {
    return null;
  }

  if (
    message.workspaceId !== target.workspaceId
    || message.sourceId === target.sourceId
    || target.seenMessageKeys.has(getMainContentInvalidationMessageKey(message))
  ) {
    return null;
  }

  return message;
};

const publishBroadcastMessage = (
  message: MainContentInvalidationMessage,
): void => {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }

  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(message);
    channel.close();
  } catch {
    // Broadcast delivery is best-effort; the caller still performs local refresh.
  }
};

const publishStorageMessage = (
  message: MainContentInvalidationMessage,
): void => {
  const storage = getStorage();
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage delivery is best-effort; denied storage must not block refresh.
  }
};

export const publishMainContentInvalidation = (
  params: MainContentInvalidationPublishParams,
): void => {
  const message: MainContentInvalidationMessage = {
    type: "main_content_invalidation",
    workspaceId: params.workspaceId,
    version: params.version,
    sourceId: params.sourceId,
    emittedAt: params.emittedAt,
  };

  publishBroadcastMessage(message);
  publishStorageMessage(message);
};

export const subscribeToMainContentInvalidation = (
  params: MainContentInvalidationSubscribeParams,
): MainContentInvalidationSubscription => {
  if (typeof window === "undefined") {
    return {
      unsubscribe: (): void => {},
    };
  }

  const handleValue = (value: unknown): void => {
    const message = getAcceptedMainContentInvalidationMessage(value, {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      seenMessageKeys: params.seenMessageKeys,
    });
    if (message !== null) {
      params.onMessage(message);
    }
  };

  const broadcastChannel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;
  const handleBroadcastMessage = (event: MessageEvent<unknown>): void => {
    handleValue(event.data);
  };
  const handleStorageMessage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || event.newValue === null) {
      return;
    }

    handleValue(parseStoredMessage(event.newValue));
  };

  broadcastChannel?.addEventListener("message", handleBroadcastMessage);
  window.addEventListener("storage", handleStorageMessage);

  return {
    unsubscribe: (): void => {
      broadcastChannel?.removeEventListener("message", handleBroadcastMessage);
      broadcastChannel?.close();
      window.removeEventListener("storage", handleStorageMessage);
    },
  };
};
