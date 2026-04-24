import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatSendRequestBody,
  ensureWritableChatSession,
} from "./chatSessionControllerRuntime";

test("ensureWritableChatSession creates a session for a fresh local chat", async (): Promise<void> => {
  let createCallCount = 0;

  const sessionId = await ensureWritableChatSession(
    null,
    async (): Promise<string> => {
      createCallCount += 1;
      return "session-1";
    },
  );

  assert.equal(sessionId, "session-1");
  assert.equal(createCallCount, 1);
});

test("ensureWritableChatSession reuses an existing session id", async (): Promise<void> => {
  let createCallCount = 0;

  const sessionId = await ensureWritableChatSession(
    "session-2",
    async (): Promise<string> => {
      createCallCount += 1;
      return "session-3";
    },
  );

  assert.equal(sessionId, "session-2");
  assert.equal(createCallCount, 0);
});

test("buildChatSendRequestBody serializes explicit session ids", (): void => {
  const requestBody = buildChatSendRequestBody(
    [{ type: "text", text: "Hello" }],
    "session-4",
  );
  const parsedRequestBody = JSON.parse(requestBody) as Readonly<{
    sessionId: string;
    content: ReadonlyArray<Readonly<{ type: string; text?: string }>>;
  }>;

  assert.equal(parsedRequestBody.sessionId, "session-4");
  assert.deepEqual(parsedRequestBody.content, [{ type: "text", text: "Hello" }]);
});
