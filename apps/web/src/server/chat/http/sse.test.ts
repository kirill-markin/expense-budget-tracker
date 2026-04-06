import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatEventStream,
  isExpectedStreamClosureError,
} from "@/server/chat/http/sse";
import type { ChatStreamEvent } from "@/server/chat/types";

const decoder = new TextDecoder();

test("createChatEventStream emits heartbeat comments while idle", async (): Promise<void> => {
  let release: () => void = () => undefined;
  const events = (async function* (): AsyncGenerator<ChatStreamEvent> {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();

  const stream = createChatEventStream({
    events,
    heartbeatIntervalMs: 1,
    onStreamError: () => undefined,
  });

  const reader = stream.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(decoder.decode(first.value), ": keep-alive\n\n");
  } finally {
    await reader.cancel();
    release();
  }
});

test("createChatEventStream forwards done events and then closes", async (): Promise<void> => {
  const stream = createChatEventStream({
    events: (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "done" };
    })(),
    heartbeatIntervalMs: 100,
    onStreamError: () => undefined,
  });

  const reader = stream.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(decoder.decode(first.value), "data: {\"type\":\"done\"}\n\n");

    const second = await reader.read();
    assert.equal(second.done, true);
  } finally {
    reader.releaseLock();
  }
});

test("createChatEventStream emits error events when the upstream generator throws", async (): Promise<void> => {
  let onStreamErrorMessage: string | null = null;

  const stream = createChatEventStream({
    events: (async function* (): AsyncGenerator<ChatStreamEvent> {
      throw new Error("boom");
    })(),
    heartbeatIntervalMs: 100,
    onStreamError: (error: string): void => {
      onStreamErrorMessage = error;
    },
  });

  const reader = stream.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(decoder.decode(first.value), "data: {\"type\":\"error\",\"message\":\"boom\"}\n\n");
    assert.equal(onStreamErrorMessage, "boom");
  } finally {
    await reader.cancel();
  }
});

test("isExpectedStreamClosureError matches known closure messages", (): void => {
  assert.equal(isExpectedStreamClosureError(new Error("Controller is already closed")), true);
  assert.equal(isExpectedStreamClosureError(new Error("ReadableStream is already closed")), true);
  assert.equal(isExpectedStreamClosureError(new Error("stream is already closed")), true);
  assert.equal(isExpectedStreamClosureError(new Error("different message")), false);
});
