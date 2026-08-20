import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatRequestDiagnostics,
  InvalidChatTimezoneError,
  parseChatRequestBody,
} from "@/server/chat/http/request";
import { LegacyPdfFileAttachmentError } from "@/server/chat/attachments/validation";
import type { PdfContentPart } from "@/server/chat/types";

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
