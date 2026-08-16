import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_PDF_REATTACH_PLACEHOLDER,
  PDF_MISSING_TEXT_PLACEHOLDER,
  PDF_RENDERED_PAGE_PLACEHOLDER,
  getAttachmentLabel,
  serializeAttachmentForMarkdown,
} from "@/lib/chatAttachments";
import type { PdfContentPart } from "@/server/chat/types";

test("logical PDF export keeps one attachment label and ordered page representations", async (): Promise<void> => {
  const pdf: PdfContentPart = {
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "f".repeat(64),
    pages: [
      { pageNumber: 1, text: "amount 42", jpegBase64Data: "/9j/" },
      { pageNumber: 2, text: "", jpegBase64Data: "/9j/" },
    ],
  };

  assert.equal(getAttachmentLabel(pdf), "statement.pdf");
  assert.deepEqual(await serializeAttachmentForMarkdown(pdf), {
    label: "statement.pdf",
    mediaType: "application/pdf",
    lines: [
      "Page 1",
      "```text",
      "amount 42",
      "```",
      PDF_RENDERED_PAGE_PLACEHOLDER,
      "Page 2",
      PDF_MISSING_TEXT_PLACEHOLDER,
      PDF_RENDERED_PAGE_PLACEHOLDER,
    ],
  });
});

test("legacy PDF export marks the file for reattachment", async (): Promise<void> => {
  const legacyPdfs = [
    {
      type: "file" as const,
      fileName: "legacy.bin",
      mediaType: "application/pdf",
      base64Data: Buffer.from("opaque").toString("base64"),
    },
    {
      type: "file" as const,
      fileName: "legacy.pdf",
      mediaType: "application/octet-stream",
      base64Data: Buffer.from("opaque").toString("base64"),
    },
    {
      type: "file" as const,
      fileName: "legacy.bin",
      mediaType: "text/plain",
      base64Data: Buffer.from("%PDF-1.7 raw").toString("base64"),
    },
  ];

  for (const legacyPdf of legacyPdfs) {
    const attachment = await serializeAttachmentForMarkdown(legacyPdf);
    assert.deepEqual(attachment.lines, [LEGACY_PDF_REATTACH_PLACEHOLDER]);
  }
});
