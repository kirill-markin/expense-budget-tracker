import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_MODEL_ID } from "@/lib/chatModels";
import { extractChatRequestContext, parseChatRequestBody } from "./route";

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
