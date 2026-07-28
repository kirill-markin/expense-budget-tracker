import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatSessionSyncPublishError,
  ChatSessionSyncSubscriptionError,
  createChatSessionSyncScope,
  getAcceptedChatSessionSyncMessage,
  getChatSessionSyncMessageKey,
  parseChatSessionSyncMessage,
  publishChatSessionSync,
  subscribeToChatSessionSync,
  type ChatSessionSyncMessage,
} from "./chatSessionSyncChannel";

type GlobalDescriptorSnapshot = Readonly<{
  window: PropertyDescriptor | undefined;
  broadcastChannel: PropertyDescriptor | undefined;
}>;

type StorageListener = (
  event: Readonly<{ key: string | null; newValue: string | null }>,
) => void;

const workspaceScope = {
  mode: "workspace" as const,
  workspaceId: "workspace-1",
};
const demoScope = {
  mode: "demo" as const,
  workspaceId: "workspace-1",
};

const createMessage = (
  overrides: Readonly<Partial<ChatSessionSyncMessage>>,
): ChatSessionSyncMessage => ({
  type: "chat_session_changed",
  scope: workspaceScope,
  sessionId: "session-1",
  sourceId: "source-other",
  emittedAt: 1_000,
  ...overrides,
});

const captureGlobalDescriptors = (): GlobalDescriptorSnapshot => ({
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  broadcastChannel: Object.getOwnPropertyDescriptor(
    globalThis,
    "BroadcastChannel",
  ),
});

const restoreGlobalProperty = (
  propertyName: "window" | "BroadcastChannel",
  descriptor: PropertyDescriptor | undefined,
): void => {
  if (descriptor === undefined) {
    Reflect.deleteProperty(globalThis, propertyName);
    return;
  }
  Object.defineProperty(globalThis, propertyName, descriptor);
};

const restoreGlobalDescriptors = (
  snapshot: GlobalDescriptorSnapshot,
): void => {
  restoreGlobalProperty("window", snapshot.window);
  restoreGlobalProperty("BroadcastChannel", snapshot.broadcastChannel);
};

test("session sync scopes distinguish workspace and demo cookies", (): void => {
  assert.deepEqual(
    createChatSessionSyncScope("workspace-1", "locale=en"),
    workspaceScope,
  );
  assert.deepEqual(
    createChatSessionSyncScope(
      "local-workspace-header-is-ignored",
      "locale=en; demo=true; chat-open=true",
    ),
    {
      mode: "demo",
      workspaceId: "",
    },
  );
});

test("session sync validates external payloads and ignores unrelated extra fields", (): void => {
  assert.deepEqual(
    parseChatSessionSyncMessage({
      ...createMessage({}),
      unrelated: "ignored",
      scope: {
        ...workspaceScope,
        unrelated: "ignored",
      },
    }),
    createMessage({}),
  );

  for (const malformed of [
    null,
    [],
    { type: "other" },
    {
      ...createMessage({}),
      scope: { ...workspaceScope, mode: "invalid" },
    },
    createMessage({ sessionId: "" }),
    createMessage({ sourceId: "" }),
    createMessage({ emittedAt: Number.NaN }),
    createMessage({ emittedAt: 1.5 }),
    createMessage({ emittedAt: -1 }),
  ]) {
    assert.equal(parseChatSessionSyncMessage(malformed), null);
  }
});

test("session sync accepts only another tab for the exact scope and session", (): void => {
  const target = {
    scope: workspaceScope,
    sessionId: "session-1",
    sourceId: "source-self",
    seenMessageKeys: new Set<string>(),
  };
  const message = createMessage({});

  assert.deepEqual(getAcceptedChatSessionSyncMessage(message, target), message);
  assert.equal(
    getAcceptedChatSessionSyncMessage(
      createMessage({ scope: demoScope }),
      target,
    ),
    null,
  );
  assert.equal(
    getAcceptedChatSessionSyncMessage(
      createMessage({
        scope: {
          mode: "workspace",
          workspaceId: "workspace-2",
        },
      }),
      target,
    ),
    null,
  );
  assert.equal(
    getAcceptedChatSessionSyncMessage(
      createMessage({ sessionId: "session-2" }),
      target,
    ),
    null,
  );
  assert.equal(
    getAcceptedChatSessionSyncMessage(
      createMessage({ sourceId: "source-self" }),
      target,
    ),
    null,
  );
});

test("BroadcastChannel subscription deduplicates, validates, and disposes exactly once", (): void => {
  const globals = captureGlobalDescriptors();
  const storageListeners = new Set<StorageListener>();
  let storageRemoveCount = 0;
  type MessageListener = (
    event: Readonly<{ data: unknown }>,
  ) => void;

  class FakeBroadcastChannel {
    public static readonly instances: Array<FakeBroadcastChannel> = [];
    public readonly name: string;
    public closeCount = 0;
    private readonly listeners = new Set<MessageListener>();

    public constructor(name: string) {
      this.name = name;
      FakeBroadcastChannel.instances.push(this);
    }

    public addEventListener(
      eventType: string,
      listener: MessageListener,
    ): void {
      assert.equal(eventType, "message");
      this.listeners.add(listener);
    }

    public removeEventListener(
      eventType: string,
      listener: MessageListener,
    ): void {
      assert.equal(eventType, "message");
      this.listeners.delete(listener);
    }

    public postMessage(_message: unknown): void {}

    public close(): void {
      this.closeCount += 1;
    }

    public dispatch(value: unknown): void {
      for (const listener of this.listeners) {
        listener({ data: value });
      }
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: FakeBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageListeners.add(listener);
      },
      removeEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageRemoveCount += 1;
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });
    const channel = FakeBroadcastChannel.instances[0];
    if (channel === undefined) {
      throw new Error("BroadcastChannel subscription was not created");
    }
    const acceptedMessage = createMessage({});

    channel.dispatch({ type: "malformed" });
    channel.dispatch(createMessage({ sourceId: "source-self" }));
    channel.dispatch(createMessage({ sessionId: "session-2" }));
    channel.dispatch(acceptedMessage);
    channel.dispatch(acceptedMessage);

    assert.equal(subscription.transport, "broadcast_channel");
    assert.equal(subscription.error, null);
    assert.equal(storageListeners.size, 1);
    assert.deepEqual(receivedMessages, [acceptedMessage]);
    subscription.unsubscribe();
    subscription.unsubscribe();
    channel.dispatch(createMessage({ emittedAt: 2_000 }));
    assert.deepEqual(receivedMessages, [acceptedMessage]);
    assert.equal(channel.closeCount, 1);
    assert.equal(storageRemoveCount, 1);
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("storage fallback reaches a healthy BroadcastChannel subscriber exactly once", (): void => {
  const globals = captureGlobalDescriptors();
  type MessageListener = (
    event: Readonly<{ data: unknown }>,
  ) => void;
  const storageListeners = new Set<StorageListener>();
  let storageRemoveCount = 0;

  class PartiallyFailingBroadcastChannel {
    public static readonly instances:
      Array<PartiallyFailingBroadcastChannel> = [];
    public closeCount = 0;
    public removeCount = 0;
    private readonly listeners = new Set<MessageListener>();

    public constructor(_name: string) {
      PartiallyFailingBroadcastChannel.instances.push(this);
    }

    public addEventListener(
      eventType: string,
      listener: MessageListener,
    ): void {
      assert.equal(eventType, "message");
      this.listeners.add(listener);
    }

    public removeEventListener(
      eventType: string,
      listener: MessageListener,
    ): void {
      assert.equal(eventType, "message");
      this.removeCount += 1;
      this.listeners.delete(listener);
    }

    public postMessage(message: unknown): void {
      for (const instance of PartiallyFailingBroadcastChannel.instances) {
        if (instance !== this) {
          instance.dispatch(message);
        }
      }
      throw new Error("Synthetic BroadcastChannel publish failure");
    }

    public close(): void {
      this.closeCount += 1;
    }

    private dispatch(value: unknown): void {
      for (const listener of this.listeners) {
        listener({ data: value });
      }
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: PartiallyFailingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (key: string, value: string): void => {
          for (const listener of storageListeners) {
            listener({ key, newValue: value });
          }
        },
      },
      addEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageListeners.add(listener);
      },
      removeEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageRemoveCount += 1;
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });
    const subscriberChannel =
      PartiallyFailingBroadcastChannel.instances[0];
    if (subscriberChannel === undefined) {
      throw new Error("BroadcastChannel subscription was not created");
    }

    const publishResult = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-other",
      emittedAt: 1_000,
    });
    const publisherChannel =
      PartiallyFailingBroadcastChannel.instances[1];
    if (publisherChannel === undefined) {
      throw new Error("BroadcastChannel publisher was not created");
    }

    assert.equal(publishResult.transport, "storage");
    assert.equal(
      publishResult.error instanceof ChatSessionSyncPublishError,
      true,
    );
    assert.deepEqual(publishResult.error?.failures, [{
      transport: "broadcast_channel",
      message:
        "BroadcastChannel publish failed: "
        + "Synthetic BroadcastChannel publish failure",
    }]);
    assert.equal(subscription.transport, "broadcast_channel");
    assert.equal(subscription.error, null);
    assert.deepEqual(receivedMessages, [createMessage({})]);
    assert.equal(publisherChannel.closeCount, 1);
    assert.equal(storageListeners.size, 1);

    subscription.unsubscribe();
    subscription.unsubscribe();
    assert.equal(subscriberChannel.removeCount, 1);
    assert.equal(subscriberChannel.closeCount, 1);
    assert.equal(storageRemoveCount, 1);
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("both-capable subscriber deduplicates healthy dual transport publication", (): void => {
  const globals = captureGlobalDescriptors();
  type MessageListener = (
    event: Readonly<{ data: unknown }>,
  ) => void;
  const storageListeners = new Set<StorageListener>();

  class DeliveringBroadcastChannel {
    public static readonly instances: Array<DeliveringBroadcastChannel> = [];
    private readonly listeners = new Set<MessageListener>();

    public constructor(_name: string) {
      DeliveringBroadcastChannel.instances.push(this);
    }

    public addEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.listeners.add(listener);
    }

    public removeEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.listeners.delete(listener);
    }

    public postMessage(message: unknown): void {
      for (const instance of DeliveringBroadcastChannel.instances) {
        if (instance !== this) {
          instance.dispatch(message);
        }
      }
    }

    public close(): void {}

    private dispatch(value: unknown): void {
      for (const listener of this.listeners) {
        listener({ data: value });
      }
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: DeliveringBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (key: string, value: string): void => {
          for (const listener of storageListeners) {
            listener({ key, newValue: value });
          }
        },
      },
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });

    const publishResult = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-other",
      emittedAt: 1_000,
    });

    assert.deepEqual(publishResult, {
      transport: "broadcast_channel",
      error: null,
    });
    assert.deepEqual(receivedMessages, [createMessage({})]);
    subscription.unsubscribe();
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("healthy BroadcastChannel publisher reaches a storage-only subscriber", (): void => {
  const globals = captureGlobalDescriptors();
  const storageListeners = new Set<StorageListener>();
  const broadcastMessages: Array<unknown> = [];

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (key: string, value: string): void => {
          for (const listener of storageListeners) {
            listener({ key, newValue: value });
          }
        },
      },
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });
    assert.equal(subscription.transport, "storage");
    assert.equal(
      subscription.error instanceof ChatSessionSyncSubscriptionError,
      true,
    );
    assert.match(
      subscription.error?.message ?? "",
      /BroadcastChannel degraded: broadcastChannel=BroadcastChannel is unavailable/u,
    );

    class RecordingBroadcastChannel {
      public constructor(_name: string) {}

      public postMessage(message: unknown): void {
        broadcastMessages.push(message);
      }

      public close(): void {}
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: RecordingBroadcastChannel,
    });

    const publishResult = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-other",
      emittedAt: 1_000,
    });

    assert.deepEqual(publishResult, {
      transport: "broadcast_channel",
      error: null,
    });
    assert.deepEqual(broadcastMessages, [createMessage({})]);
    assert.deepEqual(receivedMessages, [createMessage({})]);
    subscription.unsubscribe();
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("healthy BroadcastChannel surfaces a partial storage listener failure", (): void => {
  const globals = captureGlobalDescriptors();
  type MessageListener = (
    event: Readonly<{ data: unknown }>,
  ) => void;
  const storageListeners = new Set<StorageListener>();
  let storageRemoveCount = 0;

  class FakeBroadcastChannel {
    public static instance: FakeBroadcastChannel | null = null;
    public closeCount = 0;
    public removeCount = 0;
    private readonly listeners = new Set<MessageListener>();

    public constructor(_name: string) {
      FakeBroadcastChannel.instance = this;
    }

    public addEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.listeners.add(listener);
    }

    public removeEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.removeCount += 1;
      this.listeners.delete(listener);
    }

    public postMessage(_message: unknown): void {}

    public close(): void {
      this.closeCount += 1;
    }

    public dispatch(value: unknown): void {
      for (const listener of this.listeners) {
        listener({ data: value });
      }
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: FakeBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
        throw new Error("Synthetic storage listener failure");
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageRemoveCount += 1;
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });
    const channel = FakeBroadcastChannel.instance;
    if (channel === null) {
      throw new Error("BroadcastChannel subscription was not created");
    }

    assert.equal(subscription.transport, "broadcast_channel");
    assert.equal(
      subscription.error
        instanceof ChatSessionSyncSubscriptionError,
      true,
    );
    assert.match(
      subscription.error?.message ?? "",
      /storage fallback listener could not initialize.*Synthetic storage listener failure/u,
    );
    channel.dispatch(createMessage({}));
    assert.deepEqual(receivedMessages, [createMessage({})]);
    assert.equal(storageListeners.size, 1);

    subscription.unsubscribe();
    subscription.unsubscribe();
    assert.equal(channel.removeCount, 1);
    assert.equal(channel.closeCount, 1);
    assert.equal(storageRemoveCount, 1);
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("partial BroadcastChannel listener failure cleans up before storage fallback", (): void => {
  const globals = captureGlobalDescriptors();
  type MessageListener = (
    event: Readonly<{ data: unknown }>,
  ) => void;
  const storageListeners = new Set<StorageListener>();

  class PartiallyFailingBroadcastChannel {
    public static instance: PartiallyFailingBroadcastChannel | null = null;
    public closeCount = 0;
    public removeCount = 0;
    private readonly listeners = new Set<MessageListener>();

    public constructor(_name: string) {
      PartiallyFailingBroadcastChannel.instance = this;
    }

    public addEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.listeners.add(listener);
      throw new Error("Synthetic BroadcastChannel listener failure");
    }

    public removeEventListener(
      _eventType: string,
      listener: MessageListener,
    ): void {
      this.removeCount += 1;
      this.listeners.delete(listener);
    }

    public close(): void {
      this.closeCount += 1;
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: PartiallyFailingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (): void => {},
    });
    const channel = PartiallyFailingBroadcastChannel.instance;
    if (channel === null) {
      throw new Error("BroadcastChannel construction was not observed");
    }

    assert.equal(subscription.transport, "storage");
    assert.equal(
      subscription.error instanceof ChatSessionSyncSubscriptionError,
      true,
    );
    assert.match(
      subscription.error?.message ?? "",
      /BroadcastChannel listener registration failed: Synthetic BroadcastChannel listener failure/u,
    );
    assert.equal(channel.removeCount, 1);
    assert.equal(channel.closeCount, 1);
    assert.equal(storageListeners.size, 1);
    subscription.unsubscribe();
    subscription.unsubscribe();
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("storage fallback survives remount without replaying a duplicate signal", (): void => {
  const globals = captureGlobalDescriptors();
  const storageListeners = new Set<StorageListener>();
  let storedValue: string | null = null;
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (_key: string, value: string): void => {
          storedValue = value;
        },
      },
      addEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageListeners.add(listener);
      },
      removeEventListener: (
        eventType: string,
        listener: StorageListener,
      ): void => {
        assert.equal(eventType, "storage");
        storageListeners.delete(listener);
      },
    },
  });

  const dispatchStorage = (newValue: string | null): void => {
    for (const listener of storageListeners) {
      listener({
        key: "expense-tracker-chat-session-sync",
        newValue,
      });
    }
  };

  try {
    const publishResult = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-other",
      emittedAt: 1_000,
    });
    assert.equal(publishResult.transport, "storage");
    if (storedValue === null) {
      throw new Error("Storage fallback did not persist a sync payload");
    }

    const seenMessageKeys = new Set<string>();
    let deliveryCount = 0;
    const createSubscription = () => subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys,
      onMessage: (): void => {
        deliveryCount += 1;
      },
    });

    const firstSubscription = createSubscription();
    dispatchStorage("{");
    dispatchStorage(storedValue);
    dispatchStorage(storedValue);
    assert.equal(deliveryCount, 1);
    assert.equal(storageListeners.size, 1);
    firstSubscription.unsubscribe();
    firstSubscription.unsubscribe();
    assert.equal(storageListeners.size, 0);

    const remountedSubscription = createSubscription();
    dispatchStorage(storedValue);
    assert.equal(deliveryCount, 1);
    remountedSubscription.unsubscribe();
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("subscription falls back to storage when BroadcastChannel construction fails", (): void => {
  const globals = captureGlobalDescriptors();
  const storageListeners = new Set<StorageListener>();
  let storageRemoveCount = 0;

  class ThrowingBroadcastChannel {
    public constructor() {
      throw new Error("BroadcastChannel denied");
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: ThrowingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageRemoveCount += 1;
        storageListeners.delete(listener);
      },
    },
  });

  try {
    const receivedMessages: Array<ChatSessionSyncMessage> = [];
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (message): void => {
        receivedMessages.push(message);
      },
    });
    assert.equal(subscription.transport, "storage");
    assert.equal(
      subscription.error instanceof ChatSessionSyncSubscriptionError,
      true,
    );
    assert.match(
      subscription.error?.message ?? "",
      /BroadcastChannel degraded: broadcastChannel=BroadcastChannel initialization failed: BroadcastChannel denied/u,
    );
    assert.equal(storageListeners.size, 1);
    for (const listener of storageListeners) {
      listener({
        key: "expense-tracker-chat-session-sync",
        newValue: JSON.stringify(createMessage({})),
      });
    }
    assert.deepEqual(receivedMessages, [createMessage({})]);
    subscription.unsubscribe();
    subscription.unsubscribe();
    assert.equal(storageRemoveCount, 1);
    assert.equal(storageListeners.size, 0);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("subscription returns a typed total error when both setup paths fail", (): void => {
  const globals = captureGlobalDescriptors();
  const storageListeners = new Set<StorageListener>();
  let storageRemoveCount = 0;

  class ThrowingBroadcastChannel {
    public constructor() {
      throw new Error("Synthetic BroadcastChannel setup failure");
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: ThrowingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageListeners.add(listener);
        throw new Error("Synthetic storage setup failure");
      },
      removeEventListener: (
        _eventType: string,
        listener: StorageListener,
      ): void => {
        storageRemoveCount += 1;
        storageListeners.delete(listener);
        throw new Error("Synthetic storage cleanup failure");
      },
    },
  });

  try {
    const subscription = subscribeToChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
      onMessage: (): void => {},
    });

    assert.equal(subscription.transport, null);
    assert.equal(
      subscription.error instanceof ChatSessionSyncSubscriptionError,
      true,
    );
    assert.match(
      subscription.error.message,
      /broadcastChannel=BroadcastChannel initialization failed: Synthetic BroadcastChannel setup failure/u,
    );
    assert.match(
      subscription.error.message,
      /storage=Synthetic storage setup failure/u,
    );
    assert.match(
      subscription.error.message,
      /partial listener cleanup failed: Synthetic storage cleanup failure/u,
    );
    assert.equal(storageRemoveCount, 1);
    assert.equal(storageListeners.size, 0);
    subscription.unsubscribe();
    subscription.unsubscribe();
    assert.equal(storageRemoveCount, 1);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("publisher reports both success, partial failures, and total failure", (): void => {
  const globals = captureGlobalDescriptors();
  const broadcastMessages: Array<unknown> = [];
  const storageMessages: Array<unknown> = [];
  let storageFailure: Error | null = null;

  class RecordingBroadcastChannel {
    public constructor(_name: string) {}

    public postMessage(message: unknown): void {
      broadcastMessages.push(message);
    }

    public close(): void {}
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: RecordingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (_key: string, value: string): void => {
          if (storageFailure !== null) {
            throw storageFailure;
          }
          storageMessages.push(JSON.parse(value) as unknown);
        },
      },
    },
  });

  try {
    const published = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      emittedAt: 1_000,
    });
    assert.deepEqual(published, {
      transport: "broadcast_channel",
      error: null,
    });
    assert.deepEqual(broadcastMessages, [
      createMessage({ sourceId: "source-self" }),
    ]);
    assert.deepEqual(storageMessages, [
      createMessage({ sourceId: "source-self" }),
    ]);

    storageFailure = new Error("Synthetic storage publish failure");
    const storagePartialFailure = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      emittedAt: 2_000,
    });
    assert.equal(storagePartialFailure.transport, "broadcast_channel");
    assert.deepEqual(storagePartialFailure.error?.failures, [{
      transport: "storage",
      message:
        "localStorage publish failed: Synthetic storage publish failure",
    }]);

    class ThrowingBroadcastChannel {
      public constructor() {
        throw new Error("Synthetic BroadcastChannel failure");
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: ThrowingBroadcastChannel,
    });
    storageFailure = null;
    const broadcastPartialFailure = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      emittedAt: 3_000,
    });
    assert.equal(broadcastPartialFailure.transport, "storage");
    assert.deepEqual(broadcastPartialFailure.error?.failures, [{
      transport: "broadcast_channel",
      message:
        "BroadcastChannel construction failed: "
        + "Synthetic BroadcastChannel failure",
    }]);

    storageFailure = new Error("Synthetic total storage failure");
    const failed = publishChatSessionSync({
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      emittedAt: 4_000,
    });
    assert.equal(failed.transport, null);
    assert.equal(failed.error instanceof ChatSessionSyncPublishError, true);
    assert.deepEqual(failed.error?.failures, [
      {
        transport: "broadcast_channel",
        message:
          "BroadcastChannel construction failed: "
          + "Synthetic BroadcastChannel failure",
      },
      {
        transport: "storage",
        message:
          "localStorage publish failed: Synthetic total storage failure",
      },
    ]);
  } finally {
    restoreGlobalDescriptors(globals);
  }
});

test("message keys include scope, session, source, and emission identity", (): void => {
  const message = createMessage({});
  const seenMessageKeys = new Set<string>([
    getChatSessionSyncMessageKey(message),
  ]);

  assert.equal(
    getAcceptedChatSessionSyncMessage(message, {
      scope: workspaceScope,
      sessionId: "session-1",
      sourceId: "source-self",
      seenMessageKeys,
    }),
    null,
  );
  assert.notEqual(
    getChatSessionSyncMessageKey(message),
    getChatSessionSyncMessageKey(createMessage({ scope: demoScope })),
  );
});
