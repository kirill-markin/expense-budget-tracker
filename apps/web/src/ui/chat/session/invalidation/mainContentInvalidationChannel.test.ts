import assert from "node:assert/strict";
import test from "node:test";

import {
  getAcceptedMainContentInvalidationMessage,
  getMainContentInvalidationMessageKey,
  publishMainContentInvalidation,
  type MainContentInvalidationMessage,
} from "./mainContentInvalidationChannel";

const createMessage = (
  overrides: Readonly<Partial<MainContentInvalidationMessage>>,
): MainContentInvalidationMessage => ({
  type: "main_content_invalidation",
  workspaceId: "workspace-1",
  version: 1,
  sourceId: "source-other",
  emittedAt: 1_000,
  ...overrides,
});

test("getAcceptedMainContentInvalidationMessage accepts a valid unseen workspace message", (): void => {
  const message = createMessage({});

  assert.deepEqual(
    getAcceptedMainContentInvalidationMessage(message, {
      workspaceId: "workspace-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
    }),
    message,
  );
});

test("getAcceptedMainContentInvalidationMessage ignores malformed messages", (): void => {
  assert.equal(
    getAcceptedMainContentInvalidationMessage({ type: "other" }, {
      workspaceId: "workspace-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
    }),
    null,
  );
});

test("getAcceptedMainContentInvalidationMessage ignores other workspaces and own source", (): void => {
  assert.equal(
    getAcceptedMainContentInvalidationMessage(createMessage({ workspaceId: "workspace-2" }), {
      workspaceId: "workspace-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
    }),
    null,
  );

  assert.equal(
    getAcceptedMainContentInvalidationMessage(createMessage({ sourceId: "source-self" }), {
      workspaceId: "workspace-1",
      sourceId: "source-self",
      seenMessageKeys: new Set<string>(),
    }),
    null,
  );
});

test("getAcceptedMainContentInvalidationMessage ignores already seen messages", (): void => {
  const message = createMessage({});
  const seenMessageKeys = new Set<string>([getMainContentInvalidationMessageKey(message)]);

  assert.equal(
    getAcceptedMainContentInvalidationMessage(message, {
      workspaceId: "workspace-1",
      sourceId: "source-self",
      seenMessageKeys,
    }),
    null,
  );
});

test("publishMainContentInvalidation does not throw when browser transports fail", (): void => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalBroadcastChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");

  class ThrowingBroadcastChannel {
    constructor() {
      throw new Error("BroadcastChannel unavailable");
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: ThrowingBroadcastChannel,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        setItem: (): void => {
          throw new Error("Storage denied");
        },
      },
    },
  });

  try {
    assert.doesNotThrow(() => {
      publishMainContentInvalidation({
        workspaceId: "workspace-1",
        version: 1,
        sourceId: "source-self",
        emittedAt: 1_000,
      });
    });
  } finally {
    if (originalBroadcastChannel === undefined) {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
    } else {
      Object.defineProperty(globalThis, "BroadcastChannel", originalBroadcastChannel);
    }

    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", originalWindow);
    }
  }
});
