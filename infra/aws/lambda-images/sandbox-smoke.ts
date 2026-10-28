import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Context } from "aws-lambda";
import { handler } from "../../../apps/sandbox/src/handler.js";
import { hashObjectContent, type SandboxObjectTransfer } from "../../../apps/sandbox/src/objects.js";
import { prepareSource } from "../../../apps/sandbox/src/prepareOperation.js";

type Fixture = Readonly<{ path: string; mediaType: string; bytes: Uint8Array; expected: string }>;

const encode = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(value));

const createFixtures = async (): Promise<ReadonlyArray<Fixture>> => {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const XLSX = await import("xlsx");
  const { zipSync } = await import("fflate");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("Image PDF probe", { font });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["amount"], [42]]), "Sheet1");
  const docx = zipSync({
    "[Content_Types].xml": encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": encode('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Image DOCX probe</w:t></w:r></w:p></w:body></w:document>'),
  });
  return [
    { path: "/files/probe.pdf", mediaType: "application/pdf", bytes: await document.save(), expected: "Image PDF probe" },
    { path: "/files/probe.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx, expected: "Image DOCX probe" },
    { path: "/files/probe.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array, expected: "42" },
  ];
};

export const runSandboxSmoke = async (context: Context): Promise<void> => {
  // The real supervisor forks the same packaged index.mjs as production.
  const answer = await handler({
    operation: "bash",
    sessionId: randomUUID(),
    command: `python3 -c 'import csv,io; print(sum(int(r["amount"]) for r in csv.DictReader(io.StringIO("amount\\n19\\n23\\n"))))' && sqlite3 :memory: 'SELECT 42;'`,
    files: [],
    writeSlots: [],
  }, context);
  assert.ok("exitCode" in answer);
  assert.equal(answer.exitCode, 0, JSON.stringify(answer));
  assert.equal(answer.stdout.trim(), "42\n42");
  for (const fixture of await createFixtures()) {
    const uploaded: Array<Uint8Array> = [];
    const transfer: SandboxObjectTransfer = {
      readObject: async (url: string): Promise<Uint8Array> => {
        assert.equal(url, "https://image-probe.invalid/source");
        return fixture.bytes;
      },
      writeObject: async (_url: string, _mediaType: string, bytes: Uint8Array): Promise<void> => {
        uploaded.push(bytes);
      },
    };
    const result = await prepareSource({
      operation: "prepare",
      source: {
        path: fixture.path,
        mediaType: fixture.mediaType,
        sizeBytes: fixture.bytes.byteLength,
        sha256: hashObjectContent(fixture.bytes),
        mtimeMs: 1_700_000_000_000,
        getUrl: "https://image-probe.invalid/source",
      },
      writeSlots: [{ slotId: "probe", putUrl: "https://image-probe.invalid/output" }],
    }, transfer);
    assert.equal(result.status, "prepared", JSON.stringify(result));
    assert.equal(uploaded.length, 1, fixture.path);
    assert.ok(new TextDecoder().decode(uploaded[0]).includes(fixture.expected), fixture.path);
  }
};
