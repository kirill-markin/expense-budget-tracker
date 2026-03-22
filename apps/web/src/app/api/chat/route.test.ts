import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CHAT_MODEL_ID } from "@/lib/chatModels";
import type { ChatStreamEvent } from "@/server/chat/types";
import {
  CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
  buildChatRequestDiagnostics,
  createChatErrorLogEvent,
  createChatEventStream,
  extractChatRequestContext,
  parseChatRequestBody,
} from "./route";

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    result += decoder.decode(chunk.value, { stream: true });
  }

  result += decoder.decode();
  return result;
};

test("extractChatRequestContext reads user and workspace IDs from trusted headers", () => {
  const request = new Request("https://app.example.com/api/chat", {
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  assert.deepEqual(extractChatRequestContext(request), {
    userId: "user-1",
    workspaceId: "workspace-1",
  });
});

test("extractChatRequestContext rejects requests without a workspace header", () => {
  const request = new Request("https://app.example.com/api/chat", {
    headers: {
      "x-user-id": "user-1",
    },
  });

  assert.throws(
    () => extractChatRequestContext(request),
    /Missing x-workspace-id header/,
  );
});

test("parseChatRequestBody accepts message payload without client container identifiers", () => {
  assert.deepEqual(parseChatRequestBody({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: CHAT_MODEL_ID,
    timezone: "Europe/Madrid",
  }), {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: CHAT_MODEL_ID,
    timezone: "Europe/Madrid",
  });
});

test("parseChatRequestBody ignores legacy client container fields", () => {
  assert.deepEqual(parseChatRequestBody({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: CHAT_MODEL_ID,
    timezone: "Europe/Madrid",
    chatSessionId: "legacy-chat-id",
    codeInterpreterContainerId: "legacy-container-id",
  }), {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: CHAT_MODEL_ID,
    timezone: "Europe/Madrid",
  });
});

test("parseChatRequestBody rejects missing timezone", () => {
  assert.throws(
    () => parseChatRequestBody({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: CHAT_MODEL_ID,
      timezone: "",
    }),
    /timezone must be a non-empty string/,
  );
});

test("POST rejects models other than the pinned OpenAI model", async () => {
  const request = new Request("https://app.example.com/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: "gpt-4.1",
      timezone: "Europe/Madrid",
    }),
  });

  const { POST } = await import("./route");
  const response = await POST(request);

  assert.equal(response.status, 400);
  assert.equal(await response.text(), `Unsupported model: gpt-4.1. Expected ${CHAT_MODEL_ID}`);
});

test("buildChatRequestDiagnostics tracks message and attachment metadata", () => {
  assert.deepEqual(
    buildChatRequestDiagnostics("req-1", CHAT_MODEL_ID, [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "file", mediaType: "text/csv", base64Data: "YQ==", fileName: "report.csv" },
        ],
      },
    ], "user-1", "workspace-1"),
    {
      requestId: "req-1",
      model: CHAT_MODEL_ID,
      messageCount: 1,
      hasAttachments: true,
      attachmentFileNames: ["report.csv"],
      userId: "user-1",
      workspaceId: "workspace-1",
    },
  );
});

test("createChatErrorLogEvent includes structured chat context", () => {
  const diagnostics = buildChatRequestDiagnostics(
    "req-1",
    CHAT_MODEL_ID,
    [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    "user-1",
    "workspace-1",
  );

  assert.deepEqual(
    createChatErrorLogEvent(diagnostics, "stream", "network error"),
    {
      domain: "chat",
      action: "error",
      vendor: "openai",
      stage: "stream",
      error: "network error",
      requestId: "req-1",
      userId: "user-1",
      workspaceId: "workspace-1",
      model: CHAT_MODEL_ID,
      messageCount: 1,
      hasAttachments: false,
      attachmentFileNames: [],
    },
  );
});

test("createChatEventStream emits heartbeat comments during idle gaps", async () => {
  const stream = createChatEventStream({
    events: (async function* (): AsyncGenerator<ChatStreamEvent> {
      await delay(20);
      yield { type: "delta", text: "hello" };
      yield { type: "done" };
    })(),
    heartbeatIntervalMs: 5,
    onStreamError: (): void => {
      throw new Error("Unexpected stream error");
    },
  });

  const output = await readStream(stream);

  assert.match(output, /: keep-alive\n\n/);
  assert.match(output, /data: {"type":"delta","text":"hello"}\n\n/);
  assert.match(output, /data: {"type":"done"}\n\n/);
});

test("createChatEventStream stops heartbeats after done", async () => {
  const stream = createChatEventStream({
    events: (async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: "done" };
    })(),
    heartbeatIntervalMs: CHAT_STREAM_HEARTBEAT_INTERVAL_MS,
    onStreamError: (): void => {
      throw new Error("Unexpected stream error");
    },
  });

  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), {
    done: false,
    value: new TextEncoder().encode("data: {\"type\":\"done\"}\n\n"),
  });
  assert.deepEqual(await reader.read(), { done: true, value: undefined });

  await delay(20);

  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});

test("createChatEventStream emits an error event when the generator fails while open", async () => {
  const errors: Array<string> = [];
  const stream = createChatEventStream({
    events: (async function* (): AsyncGenerator<ChatStreamEvent> {
      await delay(5);
      throw new Error("boom");
    })(),
    heartbeatIntervalMs: 50,
    onStreamError: (error: string): void => {
      errors.push(error);
    },
  });

  const output = await readStream(stream);

  assert.match(output, /data: {"type":"error","message":"boom"}\n\n/);
  assert.deepEqual(errors, ["boom"]);
});
