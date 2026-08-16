import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_FALLBACK_MODEL_ID,
  CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  CHAT_MODEL_ID,
  CHAT_MODEL_REASONING_EFFORT,
} from "@/lib/chatModels";
import {
  countUniquePdfAttachments,
  getChatModelRollingWindowStart,
  selectChatModelRouting,
} from "@/server/chat/modelRouting";
import type { ServerChatMessage } from "@/server/chat/openai/responses/replayItems";
import type { ContentPart } from "@/server/chat/types";

const createUserMessage = (
  content: ReadonlyArray<ContentPart>,
): ServerChatMessage => ({
  role: "user",
  content,
});

const createPdf = (
  fileName: string,
  content: string,
): Extract<ContentPart, { type: "file" }> => ({
  type: "file",
  fileName,
  mediaType: "application/pdf",
  base64Data: Buffer.from(content).toString("base64"),
});

test("selectChatModelRouting keeps Sol Medium below both routing thresholds", (): void => {
  const messages: ReadonlyArray<ServerChatMessage> = [
    createUserMessage([createPdf("one.pdf", "pdf-one")]),
    createUserMessage([createPdf("two.pdf", "pdf-two")]),
    createUserMessage([createPdf("three.pdf", "pdf-three")]),
    createUserMessage([createPdf("four.pdf", "pdf-four")]),
  ];

  const decision = selectChatModelRouting(29, messages);

  assert.equal(decision.effectiveModel, CHAT_MODEL_ID);
  assert.equal(decision.effectiveReasoningEffort, CHAT_MODEL_REASONING_EFFORT);
  assert.equal(decision.reason, "default");
  assert.equal(decision.sessionUserMessageCount, 4);
  assert.equal(decision.sessionUniquePdfCount, 4);
});

test("selectChatModelRouting switches to Luna Max at the rolling user-message threshold", (): void => {
  const decision = selectChatModelRouting(30, [
    createUserMessage([{ type: "text", text: "Current turn" }]),
  ]);

  assert.equal(decision.effectiveModel, CHAT_FALLBACK_MODEL_ID);
  assert.equal(
    decision.effectiveReasoningEffort,
    CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  );
  assert.equal(decision.reason, "rolling_24h_user_messages");
});

test("persisted PDF-heavy history activates Luna on the fifth user message", (): void => {
  const messages: ReadonlyArray<ServerChatMessage> = [
    createUserMessage([createPdf("one.pdf", "pdf-one")]),
    createUserMessage([createPdf("two.pdf", "pdf-two")]),
    createUserMessage([createPdf("three.pdf", "pdf-three")]),
    createUserMessage([createPdf("four.pdf", "pdf-four")]),
    createUserMessage([{ type: "text", text: "Use the existing PDFs" }]),
  ];

  const decision = selectChatModelRouting(5, messages);

  assert.equal(decision.effectiveModel, CHAT_FALLBACK_MODEL_ID);
  assert.equal(
    decision.effectiveReasoningEffort,
    CHAT_FALLBACK_MODEL_REASONING_EFFORT,
  );
  assert.equal(decision.reason, "pdf_heavy_session");
  assert.equal(decision.sessionUserMessageCount, 5);
  assert.equal(decision.sessionUniquePdfCount, 4);
});

test("unique PDF counting uses content and excludes images and non-PDF files", (): void => {
  const firstPdf = createPdf("first-name.pdf", "same-pdf-content");
  const messages: ReadonlyArray<ServerChatMessage> = [
    createUserMessage([firstPdf]),
    createUserMessage([{ ...firstPdf, fileName: "reattached.pdf" }]),
    createUserMessage([createPdf("other.pdf", "other-pdf-content")]),
    createUserMessage([{
      type: "file",
      fileName: "not-really-a-pdf.pdf",
      mediaType: "application/octet-stream",
      base64Data: Buffer.from("opaque-file").toString("base64"),
    }]),
    createUserMessage([{
      type: "image",
      mediaType: "image/png",
      base64Data: Buffer.from("image-content").toString("base64"),
    }]),
  ];
  const originalMessages = structuredClone(messages);

  assert.equal(countUniquePdfAttachments(messages), 2);
  assert.equal(selectChatModelRouting(5, messages).reason, "default");
  assert.deepEqual(messages, originalMessages);
});

test("rolling model routing starts exactly 24 hours before evaluation", (): void => {
  const evaluatedAt = new Date("2026-05-02T13:00:00.000Z");

  assert.equal(
    getChatModelRollingWindowStart(evaluatedAt).toISOString(),
    "2026-05-01T13:00:00.000Z",
  );
});
