"use client";

export type ChatSessionSyncScope = Readonly<{
  mode: "workspace" | "demo";
  workspaceId: string;
}>;

export type ChatSessionSyncMessage = Readonly<{
  type: "chat_session_changed";
  scope: ChatSessionSyncScope;
  sessionId: string;
  sourceId: string;
  emittedAt: number;
}>;

export type ChatSessionSyncTransport =
  | "broadcast_channel"
  | "storage";

export type ChatSessionSyncPublishResult =
  | Readonly<{
    transport: ChatSessionSyncTransport;
    error: ChatSessionSyncPublishError | null;
  }>
  | Readonly<{
    transport: null;
    error: ChatSessionSyncPublishError;
  }>;

export type ChatSessionSyncSubscription =
  | Readonly<{
    transport: "broadcast_channel";
    error: ChatSessionSyncSubscriptionError | null;
    unsubscribe: () => void;
  }>
  | Readonly<{
    transport: "storage";
    error: ChatSessionSyncSubscriptionError;
    unsubscribe: () => void;
  }>
  | Readonly<{
    transport: null;
    error: ChatSessionSyncSubscriptionError;
    unsubscribe: () => void;
  }>;

type ChatSessionSyncTarget = Readonly<{
  scope: ChatSessionSyncScope;
  sessionId: string;
  sourceId: string;
  seenMessageKeys: ReadonlySet<string>;
}>;

type PublishChatSessionSyncParams = Readonly<{
  scope: ChatSessionSyncScope;
  sessionId: string;
  sourceId: string;
  emittedAt: number;
}>;

type SubscribeToChatSessionSyncParams = Readonly<{
  scope: ChatSessionSyncScope;
  sessionId: string;
  sourceId: string;
  seenMessageKeys: Set<string>;
  onMessage: (message: ChatSessionSyncMessage) => void;
}>;

type ChatSessionSyncTransportFailure = Readonly<{
  transport: ChatSessionSyncTransport;
  message: string;
}>;

type BroadcastPublishResult =
  | Readonly<{ delivered: true; failure: string | null }>
  | Readonly<{ delivered: false; failure: string }>;

const CHANNEL_NAME = "expense-tracker-chat-session-sync";
const STORAGE_KEY = "expense-tracker-chat-session-sync";
const MAX_SEEN_MESSAGE_KEYS = 256;

let browserSourceId: string | null = null;

const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isString = (value: unknown): value is string =>
  typeof value === "string";

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value >= 0;

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseStoredMessage = (rawValue: string): unknown => {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }
};

const createBrowserSourceId = (): string => {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error(
      "Browser crypto.randomUUID is unavailable for chat session sync",
    );
  }

  return crypto.randomUUID();
};

const isDemoCookieEnabled = (cookieHeader: string): boolean =>
  cookieHeader.split(";").some((part): boolean =>
    part.trim() === "demo=true",
  );

const rememberChatSessionSyncMessageKey = (
  seenMessageKeys: Set<string>,
  messageKey: string,
): void => {
  seenMessageKeys.add(messageKey);
  while (seenMessageKeys.size > MAX_SEEN_MESSAGE_KEYS) {
    const oldestMessageKey = seenMessageKeys.values().next().value;
    if (typeof oldestMessageKey !== "string") {
      throw new Error(
        "Chat session sync dedupe state exceeded its limit without an oldest key",
      );
    }
    seenMessageKeys.delete(oldestMessageKey);
  }
};

const closeBroadcastChannel = (
  channel: BroadcastChannel,
): string | null => {
  try {
    channel.close();
    return null;
  } catch (error) {
    return toErrorMessage(error);
  }
};

const publishBroadcastMessage = (
  message: ChatSessionSyncMessage,
): BroadcastPublishResult => {
  if (typeof BroadcastChannel === "undefined") {
    return {
      delivered: false,
      failure: "BroadcastChannel is unavailable",
    };
  }

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (error) {
    return {
      delivered: false,
      failure: `BroadcastChannel construction failed: ${toErrorMessage(error)}`,
    };
  }

  try {
    channel.postMessage(message);
  } catch (error) {
    const closeFailure = closeBroadcastChannel(channel);
    return {
      delivered: false,
      failure: closeFailure === null
        ? `BroadcastChannel publish failed: ${toErrorMessage(error)}`
        : `BroadcastChannel publish failed: ${toErrorMessage(error)}; `
          + `channel close also failed: ${closeFailure}`,
    };
  }

  const closeFailure = closeBroadcastChannel(channel);
  return {
    delivered: true,
    failure: closeFailure === null
      ? null
      : `BroadcastChannel publish succeeded but close failed: ${closeFailure}`,
  };
};

const publishStorageMessage = (
  message: ChatSessionSyncMessage,
): string | null => {
  if (typeof window === "undefined") {
    return "window is unavailable";
  }

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch (error) {
    return `localStorage access failed: ${toErrorMessage(error)}`;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(message));
    return null;
  } catch (error) {
    return `localStorage publish failed: ${toErrorMessage(error)}`;
  }
};

const createSubscriptionError = (
  broadcastFailure: string,
  storageFailure: unknown,
): ChatSessionSyncSubscriptionError =>
  new ChatSessionSyncSubscriptionError(
    "Chat session sync subscription could not initialize: "
    + `broadcastChannel=${broadcastFailure}; `
    + `storage=${toErrorMessage(storageFailure)}`,
  );

const createBroadcastDegradationError = (
  broadcastFailure: string,
): ChatSessionSyncSubscriptionError =>
  new ChatSessionSyncSubscriptionError(
    "Chat session sync subscription is using storage after "
    + `BroadcastChannel degraded: broadcastChannel=${broadcastFailure}`,
  );

const noopUnsubscribe = (): void => {};

const createStorageSubscription = (
  handleStorageMessage: (event: StorageEvent) => void,
  broadcastFailure: string,
  deactivate: () => void,
): ChatSessionSyncSubscription => {
  try {
    window.addEventListener("storage", handleStorageMessage);
  } catch (error) {
    deactivate();
    let cleanupFailure: string | null = null;
    try {
      window.removeEventListener("storage", handleStorageMessage);
    } catch (cleanupError) {
      cleanupFailure = toErrorMessage(cleanupError);
    }
    return {
      transport: null,
      error: createSubscriptionError(
        broadcastFailure,
        cleanupFailure === null
          ? error
          : `${toErrorMessage(error)}; partial listener cleanup failed: `
            + cleanupFailure,
      ),
      unsubscribe: noopUnsubscribe,
    };
  }

  let isSubscribed = true;
  return {
    transport: "storage",
    error: createBroadcastDegradationError(broadcastFailure),
    unsubscribe: (): void => {
      if (!isSubscribed) {
        return;
      }
      isSubscribed = false;
      deactivate();
      try {
        window.removeEventListener("storage", handleStorageMessage);
      } catch (error) {
        throw new ChatSessionSyncSubscriptionError(
          "Chat session sync storage subscription cleanup failed: "
          + `storage=${toErrorMessage(error)}`,
        );
      }
    },
  };
};

export class ChatSessionSyncPublishError extends Error {
  public readonly failures: ReadonlyArray<ChatSessionSyncTransportFailure>;

  public constructor(
    failures: ReadonlyArray<ChatSessionSyncTransportFailure>,
  ) {
    super(
      "Chat session sync publish encountered transport failures: "
      + failures.map((failure): string =>
        `${failure.transport}=${failure.message}`,
      ).join("; "),
    );
    this.name = "ChatSessionSyncPublishError";
    this.failures = failures;
  }
}

export class ChatSessionSyncSubscriptionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatSessionSyncSubscriptionError";
  }
}

export const createChatSessionSyncScope = (
  workspaceId: string,
  cookieHeader: string,
): ChatSessionSyncScope => {
  const isDemoMode = isDemoCookieEnabled(cookieHeader);
  return {
    mode: isDemoMode ? "demo" : "workspace",
    workspaceId: isDemoMode ? "" : workspaceId,
  };
};

export const getChatSessionSyncSourceId = (): string => {
  if (browserSourceId === null) {
    browserSourceId = createBrowserSourceId();
  }

  return browserSourceId;
};

export const parseChatSessionSyncMessage = (
  value: unknown,
): ChatSessionSyncMessage | null => {
  if (!isRecord(value) || !isRecord(value.scope)) {
    return null;
  }

  if (
    value.type !== "chat_session_changed"
    || (
      value.scope.mode !== "workspace"
      && value.scope.mode !== "demo"
    )
    || !isString(value.scope.workspaceId)
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.sourceId)
    || !isFiniteNonNegativeInteger(value.emittedAt)
  ) {
    return null;
  }

  return {
    type: "chat_session_changed",
    scope: {
      mode: value.scope.mode,
      workspaceId: value.scope.workspaceId,
    },
    sessionId: value.sessionId,
    sourceId: value.sourceId,
    emittedAt: value.emittedAt,
  };
};

export const getChatSessionSyncMessageKey = (
  message: ChatSessionSyncMessage,
): string =>
  JSON.stringify([
    message.scope.mode,
    message.scope.workspaceId,
    message.sessionId,
    message.sourceId,
    message.emittedAt,
  ]);

export const getAcceptedChatSessionSyncMessage = (
  value: unknown,
  target: ChatSessionSyncTarget,
): ChatSessionSyncMessage | null => {
  const message = parseChatSessionSyncMessage(value);
  if (message === null) {
    return null;
  }

  if (
    message.scope.mode !== target.scope.mode
    || message.scope.workspaceId !== target.scope.workspaceId
    || message.sessionId !== target.sessionId
    || message.sourceId === target.sourceId
    || target.seenMessageKeys.has(getChatSessionSyncMessageKey(message))
  ) {
    return null;
  }

  return message;
};

export const publishChatSessionSync = (
  params: PublishChatSessionSyncParams,
): ChatSessionSyncPublishResult => {
  const message = parseChatSessionSyncMessage({
    type: "chat_session_changed",
    scope: params.scope,
    sessionId: params.sessionId,
    sourceId: params.sourceId,
    emittedAt: params.emittedAt,
  });
  if (message === null) {
    throw new Error(
      "Chat session sync publisher received invalid local message fields",
    );
  }

  const broadcastResult = publishBroadcastMessage(message);
  const storageFailure = publishStorageMessage(message);
  const failures: Array<ChatSessionSyncTransportFailure> = [];
  if (broadcastResult.failure !== null) {
    failures.push({
      transport: "broadcast_channel",
      message: broadcastResult.failure,
    });
  }
  if (storageFailure !== null) {
    failures.push({
      transport: "storage",
      message: storageFailure,
    });
  }
  const error = failures.length === 0
    ? null
    : new ChatSessionSyncPublishError(failures);
  if (broadcastResult.delivered) {
    return {
      transport: "broadcast_channel",
      error,
    };
  }
  if (storageFailure === null) {
    return {
      transport: "storage",
      error,
    };
  }
  if (error === null) {
    throw new Error(
      "Chat session sync publication failed without transport errors",
    );
  }
  return {
    transport: null,
    error,
  };
};

export const subscribeToChatSessionSync = (
  params: SubscribeToChatSessionSyncParams,
): ChatSessionSyncSubscription => {
  if (typeof window === "undefined") {
    return {
      transport: null,
      error: new ChatSessionSyncSubscriptionError(
        "Chat session sync subscription could not initialize: "
        + "window is unavailable",
      ),
      unsubscribe: noopUnsubscribe,
    };
  }

  let isSubscribed = true;
  const handleValue = (value: unknown): void => {
    if (!isSubscribed) {
      return;
    }
    const message = getAcceptedChatSessionSyncMessage(value, {
      scope: params.scope,
      sessionId: params.sessionId,
      sourceId: params.sourceId,
      seenMessageKeys: params.seenMessageKeys,
    });
    if (message === null) {
      return;
    }

    rememberChatSessionSyncMessageKey(
      params.seenMessageKeys,
      getChatSessionSyncMessageKey(message),
    );
    params.onMessage(message);
  };
  const handleBroadcastMessage = (event: MessageEvent<unknown>): void => {
    handleValue(event.data);
  };
  const handleStorageMessage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || event.newValue === null) {
      return;
    }
    handleValue(parseStoredMessage(event.newValue));
  };

  if (typeof BroadcastChannel === "undefined") {
    return createStorageSubscription(
      handleStorageMessage,
      "BroadcastChannel is unavailable",
      (): void => {
        isSubscribed = false;
      },
    );
  }

  let broadcastChannel: BroadcastChannel;
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
  } catch (error) {
    return createStorageSubscription(
      handleStorageMessage,
      `BroadcastChannel initialization failed: ${toErrorMessage(error)}`,
      (): void => {
        isSubscribed = false;
      },
    );
  }
  try {
    broadcastChannel.addEventListener("message", handleBroadcastMessage);
  } catch (error) {
    let listenerCleanupFailure: string | null = null;
    try {
      broadcastChannel.removeEventListener(
        "message",
        handleBroadcastMessage,
      );
    } catch (cleanupError) {
      listenerCleanupFailure = toErrorMessage(cleanupError);
    }
    const closeFailure = closeBroadcastChannel(broadcastChannel);
    return createStorageSubscription(
      handleStorageMessage,
      [
        `BroadcastChannel listener registration failed: ${toErrorMessage(error)}`,
        listenerCleanupFailure === null
          ? null
          : `listener cleanup also failed: ${listenerCleanupFailure}`,
        closeFailure === null
          ? null
          : `channel close also failed: ${closeFailure}`,
      ].filter((message): message is string => message !== null).join("; "),
      (): void => {
        isSubscribed = false;
      },
    );
  }

  let subscriptionError: ChatSessionSyncSubscriptionError | null = null;
  try {
    window.addEventListener("storage", handleStorageMessage);
  } catch (error) {
    subscriptionError = new ChatSessionSyncSubscriptionError(
      "Chat session sync storage fallback listener could not initialize "
      + "while BroadcastChannel remains active: "
      + `storage=${toErrorMessage(error)}`,
    );
  }

  return {
    transport: "broadcast_channel",
    error: subscriptionError,
    unsubscribe: (): void => {
      if (!isSubscribed) {
        return;
      }
      isSubscribed = false;
      const cleanupFailures: Array<string> = [];
      try {
        broadcastChannel.removeEventListener(
          "message",
          handleBroadcastMessage,
        );
      } catch (error) {
        cleanupFailures.push(
          `broadcastChannelListener=${toErrorMessage(error)}`,
        );
      }
      const closeFailure = closeBroadcastChannel(broadcastChannel);
      if (closeFailure !== null) {
        cleanupFailures.push(`broadcastChannel=${closeFailure}`);
      }
      try {
        window.removeEventListener("storage", handleStorageMessage);
      } catch (error) {
        cleanupFailures.push(`storage=${toErrorMessage(error)}`);
      }
      if (cleanupFailures.length > 0) {
        throw new ChatSessionSyncSubscriptionError(
          "Chat session sync subscription cleanup failed: "
          + cleanupFailures.join("; "),
        );
      }
    },
  };
};
