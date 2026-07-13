import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatSendRequestBody,
  ensureWritableChatSession,
  prepareChatSendRequest,
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

test("prepareChatSendRequest sends prepared JPEGs as image parts", (): void => {
  const result = prepareChatSendRequest(
    "",
    [
      {
        fileName: "photo.jpg",
        mediaType: "image/jpeg",
        base64Data: "/9j/",
      },
    ],
    (key: string): string => key,
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") {
    assert.fail("Expected a ready chat request");
  }
  assert.deepEqual(result.contentParts, [
    {
      type: "image",
      mediaType: "image/jpeg",
      base64Data: "/9j/",
    },
  ]);
});

test("prepareChatSendRequest rejects raw HEIC before building content parts", (): void => {
  const rawHeicBase64 = Buffer.from([
    0x00, 0x00, 0x00, 0x18,
    0x66, 0x74, 0x79, 0x70,
    0x68, 0x65, 0x69, 0x63,
  ]).toString("base64");

  for (const attachment of [
    {
      fileName: "original.heic",
      mediaType: "image/heic",
      base64Data: rawHeicBase64,
    },
    {
      fileName: "clipboard-image",
      mediaType: "application/octet-stream",
      base64Data: rawHeicBase64,
    },
  ]) {
    const result = prepareChatSendRequest(
      "",
      [attachment],
      (key: string, params): string => params === undefined
        ? key
        : `${key}:${String(params.fileName)}:${String(params.reason)}`,
    );

    assert.deepEqual(result, {
      kind: "invalid_attachment",
      errorMessage: `chat.attachmentConversionFailed:${attachment.fileName}:chat.attachmentFailureInvalidFormat`,
    });
  }
});
