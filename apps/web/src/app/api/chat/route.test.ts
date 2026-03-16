import assert from "node:assert/strict";
import test from "node:test";

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

test("parseChatRequestBody accepts chatSessionId and nullable codeInterpreterContainerId", () => {
  assert.deepEqual(parseChatRequestBody({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: "openai:gpt-5-mini",
    timezone: "Europe/Madrid",
    chatSessionId: "chat-1",
    codeInterpreterContainerId: null,
  }), {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    model: "openai:gpt-5-mini",
    timezone: "Europe/Madrid",
    chatSessionId: "chat-1",
    codeInterpreterContainerId: null,
  });
});

test("parseChatRequestBody rejects missing chatSessionId", () => {
  assert.throws(
    () => parseChatRequestBody({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: "openai:gpt-5-mini",
      timezone: "Europe/Madrid",
      codeInterpreterContainerId: null,
    }),
    /chatSessionId must be a non-empty string/,
  );
});

test("parseChatRequestBody rejects non-string codeInterpreterContainerId", () => {
  assert.throws(
    () => parseChatRequestBody({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: "openai:gpt-5-mini",
      timezone: "Europe/Madrid",
      chatSessionId: "chat-1",
      codeInterpreterContainerId: 123,
    }),
    /codeInterpreterContainerId must be a string or null/,
  );
});
