import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import {
  DOCUMENT_NO_CONTENTS_PLACEHOLDER,
  PDF_MISSING_TEXT_PLACEHOLDER,
  PDF_RENDERED_PAGE_PLACEHOLDER,
  getAttachmentLabel,
  serializeAttachmentForMarkdown,
} from "@/lib/chatAttachments";
import type { FileContentPart, PdfContentPart } from "@/server/chat/types";

const buildStoredDocument = (
  path: string,
  mediaType: string,
): FileContentPart => ({
  type: "file",
  fileId: "11111111-1111-4111-8111-111111111111",
  path,
  mediaType,
  sizeBytes: 1_024,
  sha256: "a".repeat(64),
});

const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const DOCX_SENTENCE = "Quarterly travel budget is 1200 EUR.";

type ZipEntry = Readonly<{
  name: string;
  content: string;
}>;

/**
 * Minimal stored-entry ZIP writer. A `.docx` is an OPC ZIP package, so only
 * real archive bytes exercise the XML parser mammoth reads the document part
 * with.
 */
const buildStoredZip = (
  entries: ReadonlyArray<ZipEntry>,
): Buffer => {
  const localBlocks: Array<Buffer> = [];
  const centralBlocks: Array<Buffer> = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const contentBytes = Buffer.from(entry.content, "utf8");
    const checksum = crc32(contentBytes);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contentBytes.length, 18);
    localHeader.writeUInt32LE(contentBytes.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contentBytes.length, 20);
    centralHeader.writeUInt32LE(contentBytes.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    localBlocks.push(localHeader, nameBytes, contentBytes);
    centralBlocks.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + contentBytes.length;
  }

  const localBytes = Buffer.concat(localBlocks);
  const centralBytes = Buffer.concat(centralBlocks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralBytes.length, 12);
  endRecord.writeUInt32LE(localBytes.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localBytes, centralBytes, endRecord]);
};

const buildMinimalDocxBytes = (
  sentence: string,
): Buffer =>
  buildStoredZip([
    {
      name: "[Content_Types].xml",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels"'
        + ' ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd'
        + '.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + "</Types>",
    },
    {
      name: "_rels/.rels",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships'
        + ' xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Target="word/document.xml"'
        + ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        + '/officeDocument"/>'
        + "</Relationships>",
    },
    {
      name: "word/document.xml",
      content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document'
        + ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + `<w:body><w:p><w:r><w:t>${sentence}</w:t></w:r></w:p></w:body>`
        + "</w:document>",
    },
  ]);

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

test("a stored document is named in the export rather than read", async (): Promise<void> => {
  const document = buildStoredDocument("/files/budget.docx", DOCX_MEDIA_TYPE);

  assert.equal(getAttachmentLabel(document), "budget.docx");
  assert.deepEqual(await serializeAttachmentForMarkdown(document), {
    label: "budget.docx",
    mediaType: DOCX_MEDIA_TYPE,
    lines: ['[chat file "/files/budget.docx", 1024 bytes]'],
  });
});

// The export is one string built from every attachment of the transcript, so a
// part whose name cannot be read costs its own label and nothing else.
test("a document whose path carries no name is labelled rather than raised", async (): Promise<void> => {
  const document = buildStoredDocument("/files/", DOCX_MEDIA_TYPE);

  assert.deepEqual(await serializeAttachmentForMarkdown(document), {
    label: "[unnamed-attachment]",
    mediaType: DOCX_MEDIA_TYPE,
    lines: ['[chat file "/files/", 1024 bytes]'],
  });
});

test("an inline document still exports from its own bytes", async (): Promise<void> => {
  const attachment = await serializeAttachmentForMarkdown({
    type: "file",
    fileName: "rows.csv",
    mediaType: "text/csv",
    base64Data: Buffer.from("amount\n42").toString("base64"),
  });

  assert.deepEqual(attachment, {
    label: "rows.csv",
    mediaType: "text/csv",
    lines: ["```csv", "amount\n42", "```"],
  });
});

test("inline DOCX extraction reads real Word package bytes", async (): Promise<void> => {
  const attachment = await serializeAttachmentForMarkdown({
    type: "file",
    fileName: "budget.docx",
    mediaType: DOCX_MEDIA_TYPE,
    base64Data: buildMinimalDocxBytes(DOCX_SENTENCE).toString("base64"),
  });

  assert.deepEqual(attachment, {
    label: "budget.docx",
    mediaType: DOCX_MEDIA_TYPE,
    lines: [
      "```text",
      DOCX_SENTENCE,
      "```",
    ],
  });
});

// Every document of a reloaded message: the snapshot carries its name and none
// of its bytes, so the export may not render it as an empty file.
test("a document reloaded with no bytes is named and reported as holding nothing", async (): Promise<void> => {
  const attachment = await serializeAttachmentForMarkdown({
    type: "file",
    fileName: "rows.csv",
    mediaType: "text/csv",
    base64Data: "",
  });

  assert.deepEqual(attachment, {
    label: "rows.csv",
    mediaType: "text/csv",
    lines: [DOCUMENT_NO_CONTENTS_PLACEHOLDER],
  });
});
