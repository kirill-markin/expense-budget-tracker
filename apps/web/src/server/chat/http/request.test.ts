import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatRequestDiagnostics,
  InvalidChatTimezoneError,
  parseChatRequestBody,
  toChatHistoryResponse,
} from "@/server/chat/http/request";
import { LegacyPdfFileAttachmentError } from "@/server/chat/attachments/validation";
import type { ChatSessionSnapshot } from "@/server/chat/store";
import type { FileContentPart, PdfContentPart } from "@/server/chat/types";

const PDF_PART: PdfContentPart = {
  type: "pdf",
  fileName: "statement.pdf",
  mediaType: "application/pdf",
  sourceSha256: "b".repeat(64),
  pages: [{
    pageNumber: 1,
    text: "2026-08-17 -42.00",
    jpegBase64Data: "/9j/4AAQSkZJRg==",
  }],
};

const createRequestBody = (content: unknown): Readonly<Record<string, unknown>> => ({
  sessionId: "session-id",
  turnId: "00000000-0000-4000-8000-000000000000",
  model: "gpt-5.6",
  timezone: "Europe/Paris",
  content,
});

test("parseChatRequestBody accepts and preserves a nested logical PDF", (): void => {
  const parsed = parseChatRequestBody(createRequestBody([
    {
      ...PDF_PART,
      base64Data: Buffer.from("%PDF-1.7 raw source must be dropped").toString("base64"),
      pages: PDF_PART.pages.map((page) => ({
        ...page,
        rawPageBytes: "must also be dropped",
      })),
    },
    { type: "text", text: "Import this statement" },
  ]));

  assert.deepEqual(parsed.content[0], PDF_PART);
  assert.equal("base64Data" in parsed.content[0], false);
  if (parsed.content[0].type !== "pdf") {
    assert.fail("Expected a normalized PDF content part");
  }
  assert.equal("rawPageBytes" in parsed.content[0].pages[0], false);
  assert.deepEqual(
    buildChatRequestDiagnostics("request-id", parsed.model, parsed.content),
    {
      requestId: "request-id",
      model: "gpt-5.6",
      sessionId: undefined,
      messageCount: 1,
      hasAttachments: true,
      attachmentFileNames: ["statement.pdf"],
      userId: undefined,
      workspaceId: undefined,
    },
  );
});

test("parseChatRequestBody rejects malformed nested PDF content", (): void => {
  assert.throws(
    (): void => {
      parseChatRequestBody(createRequestBody([{
        ...PDF_PART,
        pages: [{ pageNumber: 1, text: "missing image" }],
      }]));
    },
    /content array contains invalid parts/u,
  );
});

test("parseChatRequestBody rejects raw PDF file parts", (): void => {
  const rawPdfBase64 = Buffer.from(
    "leading bytes\n%PDF-1.7 private contents",
  ).toString("base64");
  assert.throws(
    (): void => {
      parseChatRequestBody(createRequestBody([{
        type: "file",
        fileName: "legacy.txt",
        mediaType: "text/plain",
        base64Data: rawPdfBase64,
      }]));
    },
    (error: unknown): boolean => {
      assert.ok(error instanceof LegacyPdfFileAttachmentError);
      assert.equal(error.message.includes(rawPdfBase64), false);
      return true;
    },
  );
});

test("parseChatRequestBody rejects a timezone the browser could not resolve", (): void => {
  assert.throws(
    (): void => {
      parseChatRequestBody({
        ...createRequestBody([{ type: "text", text: "How much did I spend?" }]),
        timezone: "Etc/Unknown",
      });
    },
    (error: unknown): boolean => {
      assert.ok(error instanceof InvalidChatTimezoneError);
      assert.equal(error.timezone, "Etc/Unknown");
      assert.match(
        error.message,
        /timezone must be UTC or a supported IANA timezone, received: Etc\/Unknown/u,
      );
      return true;
    },
  );
});

test("parseChatRequestBody accepts UTC sent by browsers without a resolvable timezone", (): void => {
  const parsed = parseChatRequestBody({
    ...createRequestBody([{ type: "text", text: "How much did I spend?" }]),
    timezone: "UTC",
  });

  assert.equal(parsed.timezone, "UTC");
});

test("parseChatRequestBody preserves a legacy IANA alias timezone", (): void => {
  const parsed = parseChatRequestBody({
    ...createRequestBody([{ type: "text", text: "How much did I spend?" }]),
    timezone: "US/Pacific",
  });

  assert.equal(parsed.timezone, "US/Pacific");
});

test("the session snapshot names every document of a message and carries no bytes of one", (): void => {
  const storedDocument: FileContentPart = {
    type: "file",
    fileId: "11111111-1111-4111-8111-111111111111",
    path: "/files/rows.csv",
    mediaType: "text/csv",
    sizeBytes: 9,
    sha256: "c".repeat(64),
  };
  const snapshot: ChatSessionSnapshot = {
    sessionId: "session-id",
    runState: "idle",
    updatedAt: 1,
    activeRunId: null,
    activeRunHeartbeatAt: null,
    mainContentInvalidationVersion: 0,
    messages: [{
      itemId: "item-id",
      sessionId: "session-id",
      role: "user",
      content: [
        storedDocument,
        {
          type: "file",
          fileName: "not-converted-yet.csv",
          mediaType: "text/csv",
          base64Data: Buffer.from("amount\n42").toString("base64"),
        },
        { type: "text", text: "Import this" },
      ],
      state: "completed",
      isError: false,
      isStopped: false,
      timestamp: 1,
      updatedAt: 1,
    }],
  };

  // The unconverted document keeps its name, so the transcript still renders the
  // attachment, and loses its bytes, which the snapshot never carries.
  assert.deepEqual(toChatHistoryResponse(snapshot).messages[0].content, [
    storedDocument,
    {
      type: "file",
      fileName: "not-converted-yet.csv",
      mediaType: "text/csv",
      base64Data: "",
    },
    { type: "text", text: "Import this" },
  ]);
});

test("the session snapshot carries a finish time only for completed assistant replies", (): void => {
  const createItem = (
    itemId: string,
    role: "user" | "assistant",
    state: ChatSessionSnapshot["messages"][number]["state"],
  ): ChatSessionSnapshot["messages"][number] => ({
    itemId,
    sessionId: "session-id",
    role,
    content: [{ type: "text", text: itemId }],
    state,
    isError: state === "error",
    isStopped: state === "cancelled",
    timestamp: 100,
    updatedAt: 250,
  });
  const snapshot: ChatSessionSnapshot = {
    sessionId: "session-id",
    runState: "idle",
    updatedAt: 250,
    activeRunId: null,
    activeRunHeartbeatAt: null,
    mainContentInvalidationVersion: 0,
    messages: [
      createItem("user-completed", "user", "completed"),
      createItem("assistant-completed", "assistant", "completed"),
      createItem("assistant-in-progress", "assistant", "in_progress"),
      createItem("assistant-error", "assistant", "error"),
      createItem("assistant-cancelled", "assistant", "cancelled"),
    ],
  };

  const messages = toChatHistoryResponse(snapshot).messages;

  assert.deepEqual(
    messages.map((message) => [message.messageId, "completedAt" in message, message.completedAt]),
    [
      ["user-completed", false, undefined],
      ["assistant-completed", true, 250],
      ["assistant-in-progress", false, undefined],
      ["assistant-error", false, undefined],
      ["assistant-cancelled", false, undefined],
    ],
  );
});

test("the session snapshot gives no finish time to the partial reply of a failed run", (): void => {
  const createAssistantItem = (
    itemId: string,
    state: "completed" | "error",
    updatedAt: number,
  ): ChatSessionSnapshot["messages"][number] => ({
    itemId,
    sessionId: "session-id",
    role: "assistant",
    content: [{ type: "text", text: itemId }],
    state,
    isError: state === "error",
    isStopped: false,
    timestamp: 100,
    updatedAt,
  });
  const snapshot: ChatSessionSnapshot = {
    sessionId: "session-id",
    runState: "idle",
    updatedAt: 90_000_000,
    activeRunId: null,
    activeRunHeartbeatAt: null,
    mainContentInvalidationVersion: 0,
    messages: [
      createAssistantItem("assistant-finished", "completed", 250),
      createAssistantItem("assistant-partial", "completed", 90_000_000),
      createAssistantItem("assistant-error", "error", 90_000_000),
    ],
  };

  const messages = toChatHistoryResponse(snapshot).messages;

  assert.deepEqual(
    messages.map((message) => [message.messageId, "completedAt" in message, message.completedAt]),
    [
      ["assistant-finished", true, 250],
      ["assistant-partial", false, undefined],
      ["assistant-error", false, undefined],
    ],
  );
});
