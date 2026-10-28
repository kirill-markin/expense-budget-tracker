import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { zipSync, unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";
import {
  predictChatSandboxDerivativePaths,
  SANDBOX_PREPARE_MAX_DERIVATIVES,
  SANDBOX_WORK_FILE_MEDIA_TYPE,
  type ChatSandboxPrepareResponse,
} from "./contract.js";
import { loadConversionLibrary } from "./conversionLibrary.js";
import {
  hashObjectContent,
  ObjectContentMismatchError,
  ObjectTransferError,
  type SandboxObjectTransfer,
} from "./objects.js";
import { prepareSource } from "./prepareOperation.js";

const HOST = "objects.example";

/**
 * `Uint8Array<ArrayBuffer>`, which `TextEncoder` does not return: its result is
 * typed over `ArrayBufferLike`, and fflate's `Unzipped` is indexed by the
 * narrower type, so patching one part of an unzipped package needs the copy.
 */
const encode = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

type Upload = Readonly<{ putUrl: string; mediaType: string; content: Uint8Array }>;

type PrepareOutcome = Readonly<{
  response: ChatSandboxPrepareResponse;
  uploads: ReadonlyArray<Upload>;
}>;

type SourceOverrides = Readonly<{ sha256?: string }>;

/**
 * Prepare one source over a transfer that answers from memory.
 *
 * The uploads are collected rather than counted, because most of what these
 * tests have to prove is about what was NOT stored: a refused archive and a
 * failed upload must both leave the bucket without the derivative the answer
 * would otherwise have named.
 */
const prepare = async (
  path: string,
  mediaType: string,
  bytes: Uint8Array,
  slotCount: number,
  refuseSlotId: string | null,
  overrides: SourceOverrides,
): Promise<PrepareOutcome> => {
  const uploads: Array<Upload> = [];
  const transfer: SandboxObjectTransfer = {
    readObject: async (getUrl: string): Promise<Uint8Array> => {
      assert.equal(getUrl, `https://${HOST}${path}`);

      return bytes;
    },
    writeObject: async (putUrl: string, mediaType2: string, content: Uint8Array): Promise<void> => {
      if (refuseSlotId !== null && putUrl.endsWith(refuseSlotId)) {
        throw new Error(`object storage refused ${putUrl}`);
      }
      uploads.push({ putUrl, mediaType: mediaType2, content });
    },
  };
  const response = await prepareSource(
    {
      operation: "prepare",
      source: {
        path,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256: overrides.sha256 ?? hashObjectContent(bytes),
        mtimeMs: 1_700_000_000_000,
        getUrl: `https://${HOST}${path}`,
      },
      writeSlots: Array.from({ length: slotCount }, (_unused, index) => ({
        slotId: `slot-${String(index)}`,
        putUrl: `https://${HOST}/slot-${String(index)}`,
      })),
    },
    transfer,
  );

  return { response, uploads };
};

const requirePrepared = (
  response: ChatSandboxPrepareResponse,
): Extract<ChatSandboxPrepareResponse, { status: "prepared" }> => {
  assert.equal(response.status, "prepared", `expected a prepared answer, got ${JSON.stringify(response)}`);
  assert.ok(response.status === "prepared");

  return response;
};

const requireFailed = (
  response: ChatSandboxPrepareResponse,
): Extract<ChatSandboxPrepareResponse, { status: "failed" }> => {
  assert.equal(response.status, "failed", `expected a failed answer, got ${JSON.stringify(response)}`);
  assert.ok(response.status === "failed");

  return response;
};

/**
 * The third answer, and the reason it is asserted by status rather than by its
 * text: `failed` and `unavailable` carry the same fields, so a case that
 * matched only the message would pass against the arm that gets written down
 * permanently.
 */
const requireUnavailable = (
  response: ChatSandboxPrepareResponse,
): Extract<ChatSandboxPrepareResponse, { status: "unavailable" }> => {
  assert.equal(response.status, "unavailable", `expected an unavailable answer, got ${JSON.stringify(response)}`);
  assert.ok(response.status === "unavailable");

  return response;
};

/** A PDF with a text layer, one differently numbered line per page. */
const buildTextPdf = async (pageCount: number): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let page = 1; page <= pageCount; page += 1) {
    document.addPage([595, 842]).drawText(`Statement page ${String(page)}`, {
      x: 40,
      y: 780,
      size: 12,
      font,
    });
  }

  return document.save();
};

/**
 * A PDF whose pages carry no text at all, which is what a scan is to a parser
 * with no OCR: real page objects, real content, nothing to extract.
 */
const buildScannedPdf = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  for (let page = 0; page < 2; page += 1) {
    document.addPage([595, 842]).drawRectangle({ x: 20, y: 20, width: 555, height: 800 });
  }

  return document.save();
};

/**
 * A PDF of handwritten objects, numbered from 1 with object 1 as the catalog.
 *
 * Handwritten rather than built with pdf-lib, because what these cases need is
 * a stream whose inflated size has nothing to do with the upload's, and a
 * writer's API has no way to ask for that.
 */
const assemblePdf = (bodies: ReadonlyArray<Buffer>): Uint8Array => {
  const header = Buffer.from("%PDF-1.7\n", "latin1");
  const objects = bodies.map((body, index) => Buffer.concat([
    Buffer.from(`${String(index + 1)} 0 obj\n`, "latin1"),
    body,
    Buffer.from("\nendobj\n", "latin1"),
  ]));
  const offsets: Array<number> = [];
  let at = header.length;
  for (const object of objects) {
    offsets.push(at);
    at += object.length;
  }
  const xref = [
    "xref",
    `0 ${String(objects.length + 1)}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<</Size ${String(objects.length + 1)}/Root 1 0 R>>`,
    "startxref",
    String(at),
    "%%EOF\n",
  ].join("\n");

  return new Uint8Array(Buffer.concat([header, ...objects, Buffer.from(xref, "latin1")]));
};

const flateStreamObject = (dictionary: string, body: Buffer): Buffer => {
  const compressed = deflateSync(body, { level: 9 });

  return Buffer.concat([
    Buffer.from(`<<${dictionary}/Length ${String(compressed.length)}/Filter/FlateDecode>>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream", "latin1"),
  ]);
};

/**
 * A one-page PDF with a text layer and one image XObject of `imageBytes`
 * inflated bytes, which is the shape of every page of a scan.
 *
 * The image is in the page's resources and is drawn by the content stream, and
 * neither is why it matters: text extraction never decodes an image, so these
 * bytes are what a text pass costs nothing for and what a byte count in front
 * of the parser charges in full.
 */
const buildScanPagePdf = (imageBytes: number): Uint8Array => assemblePdf([
  Buffer.from("<</Type/Catalog/Pages 2 0 R>>", "latin1"),
  Buffer.from("<</Type/Pages/Kids[3 0 R]/Count 1>>", "latin1"),
  Buffer.from(
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</XObject<</Im0 5 0 R>>/Font<</F1 6 0 R>>>>/Contents 4 0 R>>",
    "latin1",
  ),
  flateStreamObject(
    "",
    Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q BT /F1 12 Tf 40 760 Td (Statement page 1) Tj ET", "latin1"),
  ),
  flateStreamObject(
    "/Type/XObject/Subtype/Image/Width 2480/Height 3508/ColorSpace/DeviceGray/BitsPerComponent 1",
    Buffer.alloc(imageBytes),
  ),
  Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", "latin1"),
]);

/** A real OOXML package, built as the ZIP of parts that a DOCX is. */
const buildDocx = (paragraphs: ReadonlyArray<string>): Uint8Array =>
  zipSync({
    "[Content_Types].xml": encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + "</Types>",
    ),
    "_rels/.rels": encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + "</Relationships>",
    ),
    "word/document.xml": encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("")
      + "</w:body></w:document>",
    ),
  });

const buildWorkbook = (
  sheets: ReadonlyArray<readonly [string, ReadonlyArray<ReadonlyArray<string | number>>]>,
  bookType: "xlsx" | "xls",
): Uint8Array => {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows.map((row) => [...row]));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }

  return new Uint8Array(Buffer.from(XLSX.write(workbook, { type: "buffer", bookType })));
};

/**
 * Every central-directory record of an archive, found where its end-of-
 * central-directory record says they begin.
 */
const centralDirectoryOffsets = (
  patched: Buffer,
  entryName: string | null,
): ReadonlyArray<number> => {
  const eocd = patched.lastIndexOf(Buffer.of(0x50, 0x4b, 0x05, 0x06));
  assert.notEqual(eocd, -1, "the archive carries no end-of-central-directory record");
  const signature = Buffer.of(0x50, 0x4b, 0x01, 0x02);
  const offsets: Array<number> = [];
  for (
    let at = patched.indexOf(signature, patched.readUInt32LE(eocd + 16));
    at !== -1 && at < eocd;
    at = patched.indexOf(signature, at + 1)
  ) {
    // Offset 28 of a central record is the length of the name at offset 46, so
    // one entry of an archive can be patched while its siblings stay honest.
    const name = patched.toString("utf8", at + 46, at + 46 + patched.readUInt16LE(at + 28));
    if (entryName === null || entryName === name) {
      offsets.push(at);
    }
  }

  return offsets;
};

/**
 * Rewrite the uncompressed size every central-directory record declares.
 *
 * The two archive byte caps are enforced on the sizes the archive declares,
 * which is both what fflate allocates each entry's output buffer at and what a
 * crafted archive lies about - so the case worth testing is a tiny archive
 * claiming to be enormous, not a genuinely enormous one. Offset 24 of a
 * central-directory record is its uncompressed size, per APPNOTE 4.3.12.
 */
const withDeclaredEntryBytes = (
  zip: Uint8Array,
  declaredBytes: number,
  entryName: string | null,
): Uint8Array => {
  const patched = Buffer.from(zip);
  for (const at of centralDirectoryOffsets(patched, entryName)) {
    patched.writeUInt32LE(declaredBytes, at + 24);
  }

  return new Uint8Array(patched);
};

/**
 * Rewrite the uncompressed size every LOCAL file header declares.
 *
 * The streaming reader takes its sizes from these rather than from the central
 * directory, so an archive that lies in both places is the one whose expansion
 * nothing but the arriving bytes can bound - which is what the real caps are
 * for. Each local header is found through its central-directory record, and the
 * records themselves are looked for only from where the end-of-central-
 * directory record says they begin - compressed data can carry either
 * signature, so a scan of the whole file is a scan that can patch an entry's
 * payload instead of its header. Offset 16 of the EOCD is the start of the
 * central directory, offset 42 of a central record is the local header's
 * offset, and offset 22 of a local header is its uncompressed size, per APPNOTE
 * 4.3.7, 4.3.12 and 4.3.16.
 */
const withDeclaredLocalBytes = (
  zip: Uint8Array,
  declaredBytes: number,
  entryName: string | null,
): Uint8Array => {
  const patched = Buffer.from(zip);
  for (const at of centralDirectoryOffsets(patched, entryName)) {
    patched.writeUInt32LE(declaredBytes, patched.readUInt32LE(at + 42) + 22);
  }

  return new Uint8Array(patched);
};

/**
 * An archive that stores an entry its central directory does not list.
 *
 * The end-of-central-directory record declares how many records follow it, so
 * writing 1 over a two-entry archive's count is enough: `unzip -l`, Finder and
 * Python's `zipfile` all stop after the first, while the entry is still there
 * in the local headers for a streaming reader to find. Offsets 8 and 10 of the
 * EOCD are the record counts for this disk and in total, per APPNOTE 4.3.16.
 */
const withDeclaredEntryCount = (zip: Uint8Array, count: number): Uint8Array => {
  const patched = Buffer.from(zip);
  const eocd = patched.lastIndexOf(Buffer.of(0x50, 0x4b, 0x05, 0x06));
  assert.notEqual(eocd, -1, "the archive carries no end-of-central-directory record");
  patched.writeUInt16LE(count, eocd + 8);
  patched.writeUInt16LE(count, eocd + 10);

  return new Uint8Array(patched);
};

/**
 * The mirror image: an archive whose central directory lists an entry the
 * archive does not store.
 *
 * The last entry's local header and data are spliced out while both central
 * records stay, so a tool reading the directory shows two files and a streaming
 * reader finds one. Only the EOCD's pointer to the central directory has to
 * move with it; the records' own pointers to their local headers are read by
 * nothing here, because the declared pass never asks for an entry's data and
 * the streamed pass walks the file in order.
 */
const withoutLastStoredEntry = (zip: Uint8Array): Uint8Array => {
  const source = Buffer.from(zip);
  const eocd = source.lastIndexOf(Buffer.of(0x50, 0x4b, 0x05, 0x06));
  assert.notEqual(eocd, -1, "the archive carries no end-of-central-directory record");
  const centralDirectoryStart = source.readUInt32LE(eocd + 16);
  const records = centralDirectoryOffsets(source, null);
  assert.equal(records.length, 2, "this craft needs exactly two entries");
  const lastLocalHeader = source.readUInt32LE(records[1] + 42);
  const patched = Buffer.concat([
    source.subarray(0, lastLocalHeader),
    source.subarray(centralDirectoryStart),
  ]);
  const movedEocd = patched.lastIndexOf(Buffer.of(0x50, 0x4b, 0x05, 0x06));
  patched.writeUInt32LE(
    patched.readUInt32LE(movedEocd + 16) - (centralDirectoryStart - lastLocalHeader),
    movedEocd + 16,
  );

  return new Uint8Array(patched);
};

test("a PDF with a text layer becomes one .txt with a marker per page", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/statement.pdf",
    "application/pdf",
    await buildTextPdf(3),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), ["/files/statement.pdf.txt"]);
  // The web caller predicts this path from the stored row, before it mints a
  // slot or waits on anything, so that a chat that has already taken it can be
  // told so for free. The two must name the same path.
  assert.deepEqual(
    prepared.derivatives.map((entry) => entry.path),
    predictChatSandboxDerivativePaths("pdf", "/files/statement.pdf"),
  );
  assert.deepEqual(prepared.notes, []);
  assert.equal(outcome.uploads.length, 1);
  assert.equal(outcome.uploads[0].mediaType, SANDBOX_WORK_FILE_MEDIA_TYPE);
  const text = decode(outcome.uploads[0].content);
  assert.match(text, /--- page 1 ---\nStatement page 1\n/u);
  assert.match(text, /--- page 2 ---\nStatement page 2\n/u);
  assert.match(text, /--- page 3 ---\nStatement page 3\n/u);
  // The answer describes the object that was stored, so the caller can record a
  // row for it without reading it back.
  assert.equal(prepared.derivatives[0].sizeBytes, outcome.uploads[0].content.byteLength);
  assert.equal(prepared.derivatives[0].sha256, hashObjectContent(outcome.uploads[0].content));
});

// No OCR, by decision: the pages are readable as images and the derivative says
// so rather than looking like a document with nothing in it.
test("a PDF with no text layer yields page markers, no text, and a note", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/scan.pdf",
    "application/pdf",
    await buildScannedPdf(),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), ["/files/scan.pdf.txt"]);
  assert.equal(decode(outcome.uploads[0].content).replace(/--- page \d+ ---/gu, "").trim(), "");
  assert.equal(prepared.notes.length, 1);
  assert.match(prepared.notes[0], /has no text layer/u);
  assert.match(prepared.notes[0], /read as images/u);
});

test("a DOCX becomes one .txt beside it", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/invoice.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buildDocx(["Invoice 42", "Total 99.90 EUR"]),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), ["/files/invoice.docx.txt"]);
  assert.deepEqual(
    prepared.derivatives.map((entry) => entry.path),
    predictChatSandboxDerivativePaths("docx", "/files/invoice.docx"),
  );
  assert.match(decode(outcome.uploads[0].content), /Invoice 42[\s\S]*Total 99\.90 EUR/u);
});

test("an XLSX becomes one CSV per sheet in its .d directory", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/book.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buildWorkbook([
      ["Budget", [["date", "amount"], ["2026-01-01", 12.5]]],
      ["Notes", [["note"], ["kept"]]],
    ], "xlsx"),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), [
    "/files/book.xlsx.d/Budget.csv",
    "/files/book.xlsx.d/Notes.csv",
  ]);
  // Both names came from inside the workbook, which is why nothing outside this
  // conversion may claim to predict them: the web caller has to spend the
  // invocation and check the answer it gets back.
  assert.equal(predictChatSandboxDerivativePaths("workbook", "/files/book.xlsx"), null);
  assert.equal(decode(outcome.uploads[0].content), "date,amount\n2026-01-01,12.5");
  assert.equal(decode(outcome.uploads[1].content), "note\nkept");
});

/**
 * The legacy BIFF8 format, read by the same library and reached through the
 * media type alone: the path carries no extension, so nothing but the media
 * type map can classify it.
 */
test("a legacy .xls workbook is classified by its media type", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/export",
    "application/vnd.ms-excel",
    buildWorkbook([["Budget", [["date", "amount"], ["2026-02-01", 7]]]], "xls"),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), ["/files/export.d/Budget.csv"]);
  assert.equal(decode(outcome.uploads[0].content), "date,amount\n2026-02-01,7");
});

/**
 * And reached through the filename when the media type names nothing, which is
 * what a browser that uploaded a workbook as `application/octet-stream` leaves
 * behind.
 */
test("a workbook uploaded as an opaque binary is classified by its extension", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/legacy.xls",
    "application/octet-stream",
    buildWorkbook([["Budget", [["date"], ["2026-03-01"]]]], "xls"),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), ["/files/legacy.xls.d/Budget.csv"]);
});

test("a type with no conversion produces no derivative and no upload", async (): Promise<void> => {
  const outcome = await prepare("/files/photo.png", "image/png", encode("not text"), 4, null, {});
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives, []);
  assert.equal(outcome.uploads.length, 0);
  assert.equal(prepared.notes.length, 1);
  assert.match(prepared.notes[0], /"image\/png" is not a format this chat converts/u);
});

test("every archive entry becomes a file in the .d directory, directory entries aside", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync({ "a.csv": encode("x,y\n1,2\n"), "nested/b.txt": encode("deep"), "nested/": encode("") }),
    8,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives.map((entry) => entry.path), [
    "/files/bundle.zip.d/a.csv",
    "/files/bundle.zip.d/nested/b.txt",
  ]);
  assert.equal(decode(outcome.uploads[1].content), "deep");
});

/**
 * The entry name is chosen by whoever built the archive, so each of these is a
 * write outside the derivative directory if it is taken at face value. Nothing
 * is stored for any of them: the archive is refused whole.
 */
test("an archive entry that would escape its directory is refused whole", async (): Promise<void> => {
  for (const name of ["../escape.txt", "/etc/passwd", "..\\windows.txt", "a/../../escape.txt"]) {
    const outcome = await prepare(
      "/files/bundle.zip",
      "application/zip",
      zipSync({ [name]: encode("payload"), "fine.txt": encode("kept") }),
      8,
      null,
      {},
    );
    const failed = requireFailed(outcome.response);
    assert.match(failed.error, /cannot be stored as a file/u);
    assert.equal(outcome.uploads.length, 0, `stored something for ${name}`);
  }
});

test("an archive with more entries than one source may produce is refused", async (): Promise<void> => {
  const entries = Object.fromEntries(
    Array.from({ length: SANDBOX_PREPARE_MAX_DERIVATIVES + 1 }, (_unused, index) => [
      `entry-${String(index)}.txt`,
      encode("x"),
    ]),
  );
  const outcome = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync(entries),
    SANDBOX_PREPARE_MAX_DERIVATIVES,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, new RegExp(`more than the ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} entries`, "u"));
  assert.equal(outcome.uploads.length, 0);
});

test("an archive entry declaring more than one stored file may hold is refused", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/bomb.zip",
    "application/zip",
    withDeclaredEntryBytes(zipSync({ "big.csv": encode("x,y\n1,2\n") }), 100 * 1024 * 1024 + 1, null),
    8,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /expands to 104857601 bytes, past the 104857600 bytes one stored file may hold/u);
  assert.equal(outcome.uploads.length, 0);
});

test("an archive declaring more in total than one archive may expand to is refused", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/bomb.zip",
    "application/zip",
    withDeclaredEntryBytes(
      zipSync({ "a.csv": encode("a"), "b.csv": encode("b"), "c.csv": encode("c") }),
      90 * 1024 * 1024,
      null,
    ),
    8,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /past the 134217728 bytes one archive may expand to/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * Two entries of one name collapse into one derivative, so the second would
 * replace the first with nothing to show it happened.
 */
test("an archive holding one name twice is refused", async (): Promise<void> => {
  // Built by renaming the second entry of a real archive in its central
  // directory, where fflate reads entry names: nothing a zip writer produces
  // lists one name twice, which is the point of refusing an archive that does.
  const entries = zipSync({ "a.csv": encode("first"), "b.csv": encode("second") });
  const patched = Buffer.from(entries);
  const nameAt = patched.indexOf(Buffer.from("b.csv"), patched.indexOf(Buffer.of(0x50, 0x4b, 0x01, 0x02)));
  patched.write("a.csv", nameAt, "ascii");
  const outcome = await prepare("/files/bundle.zip", "application/zip", new Uint8Array(patched), 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /holds the entry \\"a\.csv\\" twice/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * A sheet name travels into a path the same way an archive entry does, and
 * SheetJS refuses to WRITE a name with a separator in it - which is why a file
 * carrying one has to be built by patching a real workbook, and why reading one
 * is worth refusing.
 */
test("a sheet name that would escape its directory is refused", async (): Promise<void> => {
  const parts = unzipSync(buildWorkbook([["Budget", [["v"], [1]]]], "xlsx"));
  parts["xl/workbook.xml"] = encode(
    decode(parts["xl/workbook.xml"]).replace('name="Budget"', 'name="../../escape"'),
  );
  const outcome = await prepare(
    "/files/hostile.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zipSync(parts),
    8,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /its sheet \\"\.\.\/\.\.\/escape\\" cannot be stored as a file: it carries a path separator/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * The two things an entry name can be that no name rule catches: a path deeper
 * than a chat can store, which would leave a file no later command could seed,
 * and a pair where one derivative is another's parent directory, which the two
 * mounts cannot represent at all.
 */
test("a derivative set this chat could not hold is refused", async (): Promise<void> => {
  const deep = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync({ [`${"d/".repeat(300)}x.txt`]: encode("deep") }),
    8,
    null,
    {},
  );
  assert.match(requireFailed(deep.response).error, /directories deep/u);
  assert.equal(deep.uploads.length, 0);

  const collision = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync({ "a": encode("file"), "a/b": encode("under the same name") }),
    8,
    null,
    {},
  );
  assert.match(
    requireFailed(collision.response).error,
    /both as a file and as the parent directory/u,
  );
  assert.equal(collision.uploads.length, 0);
});

/**
 * A request with fewer slots than the source has parts, which is the caller's
 * mistake and not the file's.
 *
 * It used to be answered `status: "failed"`, and that is what this now reds:
 * the schema admits 1 to SANDBOX_PREPARE_MAX_DERIVATIVES slots, so a caller
 * minting 8 would have had a 30-sheet workbook recorded as permanently
 * unconvertible - a verdict on a file that is fine, reached entirely from a
 * number on the other side of the wire. Raised instead, as the concurrency
 * guard is: both mean someone wired it wrong, and neither is improved by
 * telling a model about it.
 *
 * Nothing is stored either way, which is the half of the old behaviour worth
 * keeping: the count is checked against the whole derivative set before the
 * first upload.
 */
test("a source needing more slots than the request carries is raised before any upload", async (): Promise<void> => {
  const bytes = zipSync({ "a.csv": encode("a"), "b.csv": encode("b") });
  const uploads: Array<string> = [];
  await assert.rejects(
    prepareSource(
      {
        operation: "prepare",
        source: {
          path: "/files/bundle.zip",
          mediaType: "application/zip",
          sizeBytes: bytes.byteLength,
          sha256: hashObjectContent(bytes),
          mtimeMs: 1_700_000_000_000,
          getUrl: `https://${HOST}/files/bundle.zip`,
        },
        writeSlots: [{ slotId: "slot-0", putUrl: `https://${HOST}/slot-0` }],
      },
      {
        readObject: async (): Promise<Uint8Array> => bytes,
        writeObject: async (putUrl: string): Promise<void> => {
          uploads.push(putUrl);
        },
      },
    ),
    (raised: unknown) => {
      assert.ok(raised instanceof Error);
      assert.equal(raised.name, "PrepareRequestError");
      assert.match(raised.message, /carries 1 write slots and this source needs 2/u);
      assert.match(
        raised.message,
        new RegExp(`the caller must mint ${String(SANDBOX_PREPARE_MAX_DERIVATIVES)} of them`, "u"),
      );

      return true;
    },
  );
  assert.deepEqual(uploads, [], "a request that could not be served stored something");
});

/**
 * A derivative that was built and accepted and then could not be stored, which
 * is object storage failing and not a property of the archive.
 *
 * Two things to prove. The caller records a row per derivative the answer
 * names, so a prepare that could not finish must name none: half an archive
 * recorded as a whole one is an archive the model would read as complete. And
 * it must not be `failed`, which is written down as a permanent
 * derivatives_error for this file - a bucket refusing writes for a minute would
 * leave every archive uploaded in that minute marked unconvertible for good.
 *
 * `unavailable` and not a raise, which is the correction: raising made it a
 * Lambda FunctionError, and that alarm fires on the first one and tells an
 * operator to look for a bug that is not there. This is the most retryable
 * failure the operation has - the derivatives are built and already known to be
 * storable, so only the transfer is left to fail.
 *
 * It reds the upload moving back inside the phase-2 catch, which answered it
 * `failed`, and it reds the raise that replaced that.
 */
test("a prepare whose upload fails is answered as unavailable", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync({ "a.csv": encode("a"), "b.csv": encode("b"), "c.csv": encode("c") }),
    8,
    "slot-1",
    {},
  );
  const unavailable = requireUnavailable(outcome.response);
  assert.match(unavailable.error, /could not be prepared now/u);
  assert.match(unavailable.error, /object storage refused/u);
  // The first slot was spent before the second failed, so the objects of a
  // half-stored set exist - and the answer names none of them, which is what
  // keeps the caller from recording half an archive as a whole one.
  assert.equal(outcome.uploads.length, 1);
});

/**
 * The same check a /files read makes, for the same reason: a derivative taken
 * from bytes the chat was told it is not reading would be another document's
 * content stored under this one's name.
 */
test("a source whose bytes do not match the row's digest is refused", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/statement.pdf",
    "application/pdf",
    await buildTextPdf(1),
    4,
    null,
    { sha256: "b".repeat(64) },
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /has sha256 [0-9a-f]{64}, expected b{64}/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * Read one source over a transfer that fails the way the caller chooses.
 *
 * The source is a PDF whose bytes would fail to parse, so a case that stopped
 * raising cannot pass by converting something: the only answers reachable here
 * are the read's own.
 */
const prepareOverFailingRead = (error: unknown): Promise<ChatSandboxPrepareResponse> => {
  const bytes = encode("%PDF-1.7 not really");

  return prepareSource(
    {
      operation: "prepare",
      source: {
        path: "/files/statement.pdf",
        mediaType: "application/pdf",
        sizeBytes: bytes.byteLength,
        sha256: hashObjectContent(bytes),
        mtimeMs: 1_700_000_000_000,
        getUrl: `https://${HOST}/files/statement.pdf`,
      },
      writeSlots: [],
    },
    {
      readObject: (): Promise<Uint8Array> => Promise.reject(error),
      writeObject: (): Promise<void> =>
        Promise.reject(new Error("a source that was never read stored something")),
    },
  );
};

/**
 * Every way a read can fail because of object storage, and the answer all of
 * them get.
 *
 * `status: "failed"` means "this file could not be prepared", and the caller
 * records it as a permanent derivatives_error it never retries. None of these
 * is about the file: storage refused the URL, storage was unreachable through
 * all three attempts, the invocation's transfer budget ran out - and the same
 * source read a minute later would have converted. So each is answered
 * `unavailable`, which carries no derivatives either and is the one arm the
 * caller may retry.
 *
 * The classification is classifyObjectReadFailure's, which is also what a
 * /files read in bashOperation.ts and presignedFs.ts is classified by, so there
 * is one answer to what a read failure is.
 *
 * Each case reds both shapes this has had: the blanket catch that answered them
 * `failed` and wrote an outage down against the files that arrived during it,
 * and the re-raise that replaced it, which turned a transient 503 into a Lambda
 * FunctionError on an alarm whose threshold is one error in fifteen minutes.
 *
 * The last four are the ones the prose used to name and the fixtures used to
 * dodge. Every way a pre-signed transfer fails below the status line arrives as
 * a TypeError carrying the socket, DNS or TLS error as its `cause`, and the
 * defect predicate ahead of the classification tested the class alone - so all
 * four were raised and the whole arm below was dead for the commonest transient
 * failure this operation has. Driven end to end against a server that drops the
 * socket, `prepare` produced a FunctionError and no response at all, while an
 * HTTP 503 through the same code answered `unavailable`. The causes are the ones
 * measured on Node 24.19, because the cause is what the predicate reads.
 */
const STORAGE_FAULTS: ReadonlyArray<Readonly<{ label: string; error: Error }>> = [
  {
    label: "storage refused the pre-signed URL",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 403: AccessDenied", 403),
  },
  {
    label: "a 5xx outlived all three attempts",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 503: SlowDown", 503),
  },
  {
    label: "storage answered nothing at all",
    error: new ObjectTransferError("Pre-signed object read failed: socket closed", null),
  },
  {
    label: "the transfer budget was exhausted",
    error: new Error(
      "Pre-signed transfer budget is exhausted: the invocation deadline passed 12 ms ago",
    ),
  },
  {
    label: "the socket closed before any headers",
    error: new TypeError("fetch failed", {
      cause: new Error("other side closed", { cause: "UND_ERR_SOCKET" }),
    }),
  },
  {
    label: "the socket closed part way through the body",
    error: new TypeError("terminated", {
      cause: new Error("other side closed", { cause: "UND_ERR_SOCKET" }),
    }),
  },
  {
    label: "the connection was refused",
    error: new TypeError("fetch failed", { cause: new Error("bad port") }),
  },
  {
    label: "the host did not resolve",
    error: new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }),
  },
];

for (const { label, error } of STORAGE_FAULTS) {
  test(`a read that failed because ${label} is answered as unavailable`, async (): Promise<void> => {
    const unavailable = requireUnavailable(await prepareOverFailingRead(error));
    assert.match(unavailable.error, /"\/files\/statement\.pdf" could not be prepared now/u);
    assert.match(unavailable.error, new RegExp(error.message.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  });
}

/**
 * How much of a retry each `unavailable` read is worth, which the status alone
 * cannot say.
 *
 * `unavailable` means "come back to this file", and for a transfer that got no
 * answer at all that is the whole instruction. For a read storage answered with
 * a status it is not: that one answer is an expired signature, which a fresh
 * tool call fixes, and equally a deleted object or a revoked bucket policy,
 * which answer the same way forever. With no bound in the response, a caller
 * that follows this contract retries a `NoSuchKey` for as long as the row
 * exists and the file never reaches a terminal state.
 *
 * One attempt, which is the number bashOperation.ts gives the model over the
 * same classification, and stated in the reason because the status is a single
 * word and the caller may not parse the text for a verdict - only for an
 * instruction.
 *
 * The split below is classifyObjectReadFailure's and is worth seeing here: a
 * status is `denied` whatever the status is, so the 503 that outlived its three
 * attempts is bounded alongside the 404 and only a transfer with no answer at
 * all is not. Both directions, because a bound appended to everything would be
 * as wrong as none - it would tell a caller to give up on a socket that
 * dropped, which is the failure the `unavailable` arm was added for.
 */
const RETRY_BOUNDS: ReadonlyArray<Readonly<{ label: string; error: Error; bounded: boolean }>> = [
  {
    label: "storage refused the pre-signed URL",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 403: AccessDenied", 403),
    bounded: true,
  },
  {
    label: "the object is gone",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 404: NoSuchKey", 404),
    bounded: true,
  },
  {
    label: "a 5xx outlived all three attempts",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 503: SlowDown", 503),
    bounded: true,
  },
  {
    label: "storage answered nothing at all",
    error: new ObjectTransferError("Pre-signed object read failed: socket closed", null),
    bounded: false,
  },
  {
    label: "the socket closed part way through the body",
    error: new TypeError("terminated", { cause: new Error("other side closed") }),
    bounded: false,
  },
  {
    label: "the transfer budget was exhausted",
    error: new Error("Pre-signed transfer budget is exhausted: the invocation deadline passed 12 ms ago"),
    bounded: false,
  },
];

for (const { label, error, bounded } of RETRY_BOUNDS) {
  test(`an unavailable read because ${label} ${bounded ? "states" : "does not state"} a retry bound`, async (): Promise<void> => {
    const unavailable = requireUnavailable(await prepareOverFailingRead(error));
    const bound = /worth exactly one more attempt with freshly signed URLs/u;
    if (bounded) {
      assert.match(unavailable.error, bound);
      assert.match(unavailable.error, /a deleted object or a revoked bucket policy answers the same way/u);
    } else {
      assert.doesNotMatch(unavailable.error, bound);
    }
  });
}

/**
 * And the read failure that is not storage's at all, which stays a raise.
 *
 * classifyObjectReadFailure calls a TypeError with no cause `unknown`, the same
 * kind it gives a transfer error it cannot place, so without the defect check
 * in front of it this workspace's own bug would be answered as a retryable
 * outage - told to the caller as "try again", for as long as the bug exists,
 * with nothing anywhere saying the sandbox is broken. It reds that ordering.
 *
 * No cause, and that is now load-bearing rather than incidental: it is the one
 * thing distinguishing this from the four transport cases above, which are
 * TypeErrors too. A predicate that went back to testing the class alone would
 * red those four; a predicate that exempted every TypeError would red this one.
 */
test("a read that failed because this workspace dereferenced undefined is raised", async (): Promise<void> => {
  const error = new TypeError("Cannot read properties of undefined (reading 'byteLength')");
  assert.equal(error.cause, undefined, "the fixture no longer isolates what the predicate reads");
  await assert.rejects(prepareOverFailingRead(error), (raised: unknown) => {
    assert.equal(raised, error, "the failure the caller has to see was replaced");

    return true;
  });
});
/**
 * And the two read failures that ARE about the file, which stay answers.
 *
 * The bytes are not the object the request described, so the row this chat read
 * the file's size and digest from and the object itself disagree. No retry
 * changes that, and the answer names both numbers, so this is the one read
 * failure worth writing down against the file - the same judgement
 * bashOperation.ts records as `size_mismatch` and `digest_mismatch` and tells
 * the model not to retry.
 */
for (const mismatch of ["size", "digest"] as const) {
  test(`a read whose bytes are the wrong ${mismatch} is answered as this file's own`, async (): Promise<void> => {
    const failed = requireFailed(await prepareOverFailingRead(
      new ObjectContentMismatchError("Object for '/files/statement.pdf' is wrong", mismatch),
    ));
    assert.match(failed.error, /"\/files\/statement\.pdf" could not be prepared/u);
    assert.match(failed.error, /is wrong/u);
  });
}

/**
 * A parser this build cannot load, which is the failure that reads most like a
 * broken document and is least like one.
 *
 * Measured against esbuild 0.28.2: a bundle emitted without the createRequire
 * banner of infra/aws/lambda-images/build.mjs fails `await import("mammoth")` with
 * `Dynamic require of "url" is not supported`, and that is what every DOCX of
 * such a deployment would be answered with - permanently, for files that are
 * fine. So the load is labelled where it happens, and prepareSource re-raises
 * what carries the label.
 */
test("a DOCX whose parser this build cannot load is raised rather than answered", async (): Promise<void> => {
  const docx = buildDocx(["Statement total 1234.56"]);
  const convert = (): Promise<PrepareOutcome> => prepare(
    "/files/report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docx,
    4,
    null,
    {},
  );
  // Injected rather than imitated: the point is the arm that tells a library
  // failure from a corrupt document, and both arrive from the same `await`
  // inside the same `catch`, so only a real failed resolution proves it. The
  // hook is narrow - one specifier - and deregistered, because every later
  // conversion of this file needs the same library.
  const hooks = registerHooks({
    resolve: (specifier, context, next) => {
      if (specifier === "mammoth") {
        throw new Error('Dynamic require of "url" is not supported');
      }

      return next(specifier, context);
    },
  });
  try {
    await assert.rejects(convert(), /could not load the 'mammoth' library/u);
  } finally {
    hooks.deregister();
  }

  // And the same document converts with the hook gone, so this case proves the
  // classification rather than a broken fixture.
  requirePrepared((await convert()).response);
});

/**
 * The pdf.js failure that is not an import failure, and that the wrapper above
 * did not cover until it was told to.
 *
 * pdf.js resolves its worker at the first `getDocument`, not at the import:
 * finding nothing on `globalThis.pdfjsWorker`, it falls back to `await
 * import(this.workerSrc)` and fails with "Setting up fake worker failed" -
 * inside phase 2's catch, where the answer is a permanent verdict on the user's
 * file. So a bundle emitted without the static import of pdf.worker.mjs would
 * have had every PDF of that deployment recorded as unconvertible, which the
 * image bundle guard in infra/aws/lambda-images/build.mjs prevents.
 *
 * The global is stubbed rather than deleted, because `??=` would otherwise
 * import the real worker and leave nothing to prove. It reds loadPdfjs without
 * its requirePdfWorker line: with the check gone this answers `failed`.
 */
test("a pdf.js with no worker on the global is raised rather than answered", async (): Promise<void> => {
  const pdf = await buildTextPdf(1);
  const convert = (): Promise<PrepareOutcome> =>
    prepare("/files/statement.pdf", "application/pdf", pdf, 4, null, {});
  const realWorker: unknown = globalThis.pdfjsWorker;
  globalThis.pdfjsWorker = {};
  try {
    await assert.rejects(convert(), (raised: unknown) => {
      assert.ok(raised instanceof Error);
      assert.equal(raised.name, "ConversionLibraryError");
      assert.match(raised.message, /could not load the 'pdfjs-dist' library/u);
      assert.match(raised.message, /carries no WorkerMessageHandler/u);

      return true;
    });
  } finally {
    globalThis.pdfjsWorker = realWorker;
  }

  // And the same PDF converts with the real worker back, so this case proves
  // the classification rather than a fixture that was never convertible.
  requirePrepared((await convert()).response);
});

/**
 * A fault of this repository's own code inside the conversion, which phase 2
 * used to answer as the document's.
 *
 * The asymmetry that was wrong: the read phase is almost all library code and
 * raised anything it could not place, while the parse phase is almost all ours
 * - the archive walk, the caps, the name rules, the text budget - and answered
 * everything as a verdict. So a property read off undefined in any of that was
 * written down as a permanent derivatives_error against a file that is fine.
 *
 * Injected at the one seam a test has into that phase: SheetJS is replaced by a
 * module whose `read` throws a TypeError, standing in for the TypeError this
 * workspace's own code would raise in the same place. The replacement is a data
 * URL so it cannot collide with the real module in the loader cache, and the
 * hook is deregistered because every later case in this file needs the library.
 *
 * It reds the phase-2 catch without its isSandboxDefect check: with it gone
 * this is answered `failed`.
 */
test("a TypeError raised while converting is raised rather than answered", async (): Promise<void> => {
  const workbook = buildWorkbook([["Budget", [["date"], ["2026-01-01"]]]], "xlsx");
  const convert = (): Promise<PrepareOutcome> => prepare(
    "/files/book.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbook,
    4,
    null,
    {},
  );
  const stub = "export const read = () => { throw new TypeError(\"Cannot read properties of undefined (reading 'SheetNames')\"); };\nexport const utils = {};\n";
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === "xlsx"
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : next(specifier, context),
  });
  try {
    await assert.rejects(convert(), (raised: unknown) => {
      assert.ok(raised instanceof TypeError, `a ${String(raised)} reached the caller instead of the TypeError`);
      assert.match(raised.message, /reading 'SheetNames'/u);

      return true;
    });
  } finally {
    hooks.deregister();
  }

  requirePrepared((await convert()).response);
});

/**
 * And the one RangeError inside that phase which is the document and not us.
 *
 * `utils.sheet_to_csv` returns a whole sheet's CSV before anything counts it,
 * so past the 536,870,888 characters a V8 string may hold it raises
 * `RangeError: Invalid string length` from inside SheetJS. The predicate calls
 * a RangeError this repository's own bug - correctly, everywhere but here - so
 * this reached the caller as a Lambda FunctionError, which pages an operator
 * and returns nothing a chat can show.
 *
 * It is reachable inside every cap. Measured on Node 24.19 with a .xlsx whose
 * cells all point at one 32,000-character shared string: 40,977 bytes build
 * 534,416,699 characters - 99.5% of the cap - and return, while 41,456 bytes
 * raise in 1.28 s at 628 MiB. So a 1% larger file crosses it, and the text
 * allowance never gets to refuse it, because it is spent on the string after
 * the string exists.
 *
 * Injected at the same seam the case above uses, rather than by building the
 * 41 KB fixture here: what this case is about is which channel the RangeError
 * leaves by, the real one costs the suite 628 MiB and 1.3 s to produce an error
 * object this constructs exactly, and the reachability is the measurement
 * above. The stub's `read` is real enough for the sheet list and the name
 * rules to run, so the refusal is reached through the ordinary path.
 *
 * It reds asSourceTextTooLarge being absent from the sheet loop, and it reds a
 * RangeError exempted in the predicate instead - which would have answered a
 * genuine out-of-range bug anywhere in this phase as the user's file being
 * broken.
 *
 * The stub's message is the half of the identity this asserts: the case below
 * is the other half, and together they say that this answer belongs to
 * `Invalid string length` and to nothing else wearing the same class.
 */
test("a sheet whose text will not fit in one string is the file's own refusal", async (): Promise<void> => {
  const workbook = buildWorkbook([["Budget", [["date"], ["2026-01-01"]]]], "xlsx");
  const convert = (): Promise<PrepareOutcome> => prepare(
    "/files/book.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbook,
    4,
    null,
    {},
  );
  const stub = "export const read = () => ({ SheetNames: ['Budget'], Sheets: { Budget: {} } });\n"
    + "export const utils = { sheet_to_csv: () => { throw new RangeError('Invalid string length'); } };\n";
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === "xlsx"
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : next(specifier, context),
  });
  let failed;
  try {
    failed = requireFailed((await convert()).response);
  } finally {
    hooks.deregister();
  }
  assert.match(failed.error, /"\/files\/book\.xlsx" could not be prepared/u);
  assert.match(failed.error, /its sheet \\"Budget\\" needs more extractable text than one JavaScript string can hold/u);
  assert.match(failed.error, /Invalid string length/u);

  requirePrepared((await convert()).response);
});

/**
 * The RangeError messages of that same expression which are not this answer's.
 *
 * Two of them, and two is the point. A narrowing wide enough to be wrong can be
 * wrong in more than one way, and one message only reds the narrowings that
 * happen to admit it: `Maximum call stack size exceeded` carries no "length",
 * so a narrowing written as a test on "length" admits `Invalid typed array
 * length: -1` and passes on the call-stack message alone. Both strings are
 * V8's own text on Node 24.19, so the pair reds a test on `length`, a test on
 * `exceeded`, and a test on nothing but the class.
 */
const FOREIGN_RANGE_ERROR_MESSAGES = [
  "Maximum call stack size exceeded",
  "Invalid typed array length: -1",
] as const;

/**
 * And the RangeErrors inside the same expression which are neither the document
 * nor that one error.
 *
 * The class is not the error. Measured on Node 24.19, `Maximum call stack size
 * exceeded` is a RangeError, and SheetJS and mammoth both walk their documents
 * recursively - a DOCX table nests arbitrarily - so a deep enough package
 * raises one at exactly the site the case above stubs; `Invalid typed array
 * length: -1`, `Invalid array length` and `Array buffer allocation failed` are
 * RangeErrors there too. Matched by class they all got the answer above: a
 * permanent, model-visible verdict on the user's file stating a reason that is
 * not true of it, with nothing anywhere saying the sandbox was the one at
 * fault.
 *
 * So this one raises instead, which is the answer sandboxDefect.ts gives every
 * other RangeError in this build, and it raises carrying V8's own text - the
 * only thing that can later say whether a nesting bound is worth adding. The
 * identity of the raised error is asserted and not just the rejection, because
 * a conversion that failed for some other reason would also reject here.
 *
 * It reds asSourceTextTooLarge matching RangeError by class, which is what it
 * did, and it reds any narrowing still wide enough to admit either message - a
 * test on `length`, on `exceeded`, or on nothing but the class. The case above
 * reds a narrowing in the other direction, because its stub's message is the
 * one this answer does belong to.
 */
test("a RangeError that is not a string-length overflow stays a defect of this build", async (): Promise<void> => {
  const workbook = buildWorkbook([["Budget", [["date"], ["2026-01-01"]]]], "xlsx");
  for (const message of FOREIGN_RANGE_ERROR_MESSAGES) {
    const stub = "export const read = () => ({ SheetNames: ['Budget'], Sheets: { Budget: {} } });\n"
      + `export const utils = { sheet_to_csv: () => { throw new RangeError(${JSON.stringify(message)}); } };\n`;
    const hooks = registerHooks({
      resolve: (specifier, context, next) => specifier === "xlsx"
        ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
        : next(specifier, context),
    });
    try {
      await assert.rejects(
        prepare(
          "/files/nested.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          workbook,
          4,
          null,
          {},
        ),
        (raised: unknown) => {
          assert.ok(
            raised instanceof RangeError,
            `a RangeError that is not this operation's reached the caller as something else: ${String(raised)}`,
          );
          assert.equal(
            raised.message,
            message,
            "the raised error is not the one the library threw",
          );

          return true;
        },
      );
    } finally {
      hooks.deregister();
    }
  }
});

test("a conversion library that cannot be loaded is labelled a defect of this build", async (): Promise<void> => {
  const cause = new Error('Dynamic require of "url" is not supported');
  await assert.rejects(
    loadConversionLibrary("mammoth", () => Promise.reject(cause)),
    (raised: unknown) => {
      assert.ok(raised instanceof Error);
      assert.equal(raised.name, "ConversionLibraryError");
      assert.match(raised.message, /could not load the 'mammoth' library/u);
      assert.match(raised.message, /defect of this build rather than a property of any source/u);
      assert.match(raised.message, /Dynamic require of "url" is not supported/u);
      assert.equal(raised.cause, cause);

      return true;
    },
  );
  assert.equal(
    await loadConversionLibrary("xlsx", () => Promise.resolve("the module")),
    "the module",
    "a library that loads was not passed through",
  );
});

test("a source that is not the document its type claims fails with the reason", async (): Promise<void> => {
  const outcome = await prepare("/files/broken.pdf", "application/pdf", encode("%PDF-1.7 not really"), 4, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /"\/files\/broken\.pdf" could not be prepared/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * What a declared size is worth, from the other side. `unzipSync` reads the
 * central directory and allocates each entry's output at the size it finds
 * there, so an archive that understates one yields a truncated derivative that
 * looks exactly like a complete one; the streaming reader takes the size from
 * the entry's own local file header and counts what actually arrives, which is
 * why the caps no longer depend on what was declared.
 *
 * That is not a reason to let the lie through. `unzip`, Finder and Python's
 * `zipfile` all list the central directory, so a user who vetted the archive
 * before sending it inspected the 10 byte entry and the agent would read the
 * 100,000 byte one - a different file from the one that was checked, in a chat
 * about financial statements. The two passes already hold both numbers per
 * name, so the archive is refused rather than quietly resolved in our favour.
 *
 * This is the weaker half of that disagreement; the stronger one, where a name
 * is in only one of the two lists, is the pair of tests below.
 */
test("an archive whose central directory understates an entry is refused", async (): Promise<void> => {
  const body = "x".repeat(100_000);
  const archive = withDeclaredEntryBytes(zipSync({ "big.csv": encode(body) }), 10, null);
  const outcome = await prepare("/files/bundle.zip", "application/zip", archive, 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /its entry \\"big\.csv\\" holds 100000 bytes and its central directory declares 10/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * And the cap that follows from it: with both copies of the second entry's
 * declared size lying, the only thing left to bound the expansion is the bytes
 * themselves. The refusal has to arrive while that entry is still inflating,
 * because a cap that only describes what already happened is not a memory
 * bound - which is also why the first entry declares itself honestly, so that
 * nothing about it has finished being wrong by the time the second one starts.
 */
test("an archive whose real expansion passes the cap is refused while it arrives", async (): Promise<void> => {
  const archive = withDeclaredLocalBytes(
    withDeclaredEntryBytes(
      zipSync({ "a.bin": new Uint8Array(60 * 1024 * 1024), "b.bin": new Uint8Array(70 * 1024 * 1024) }, { level: 1 }),
      1,
      "b.bin",
    ),
    1,
    "b.bin",
  );
  const outcome = await prepare("/files/bomb.zip", "application/zip", archive, 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /expands to at least \d+ bytes, past the 134217728 bytes one archive may expand to/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * The text allowance, which is about the derivative and not about memory: a
 * .docx whose one paragraph holds more characters than one source may be
 * converted into. The conversion itself fits - it is the stored sidecar and
 * every later read of it that would not.
 */
test("a source holding more text than it may be converted into is refused", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/invoice.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buildDocx(["a".repeat(34_000_000)]),
    8,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /it holds at least \d+ characters of extractable text, past the 33554432 characters one source may be converted into/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * And the archive bound's per-entry streamed half, for the same reason: one
 * entry larger than a stored file may be, declared as one byte in both copies,
 * is refused by the bytes that arrive rather than by anything it claimed.
 */
test("an archive entry whose real bytes pass what a file may hold is refused while they arrive", async (): Promise<void> => {
  const archive = withDeclaredLocalBytes(
    withDeclaredEntryBytes(zipSync({ "big.bin": new Uint8Array(101 * 1024 * 1024) }, { level: 1 }), 1, null),
    1,
    null,
  );
  const outcome = await prepare("/files/bomb.zip", "application/zip", archive, 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /expands to at least \d+ bytes, past the 104857600 bytes one stored file may hold/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * Windows with Excel installed reports a `.csv` as `application/vnd.ms-excel`,
 * which is a type this chat does convert - so without the extension deciding,
 * an ordinary CSV would spend a write slot on a sidecar repeating the upload
 * byte for byte.
 */
test("a CSV the browser called a workbook produces no derivative", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/export.csv",
    "application/vnd.ms-excel",
    encode("date,amount\n2026-01-01,12.5\n"),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives, []);
  assert.equal(outcome.uploads.length, 0);
  assert.equal(prepared.notes.length, 1);
  assert.match(prepared.notes[0], /is already the plain text a derivative would hold/u);
});

/**
 * A media type that names a format is believed even when it names one with no
 * derivative: the alternative is handing a PNG to pdf.js because the user
 * called it `report.pdf`, which throws and has the caller record a permanent
 * failure for an ordinary mistake.
 */
test("a known media type is not second-guessed by the file name", async (): Promise<void> => {
  const outcome = await prepare("/files/report.pdf", "image/png", encode("not a pdf"), 4, null, {});
  const prepared = requirePrepared(outcome.response);
  assert.deepEqual(prepared.derivatives, []);
  assert.equal(outcome.uploads.length, 0);
  assert.match(prepared.notes[0], /"image\/png" is not a format this chat converts/u);
});

/**
 * Nothing is written for a directory entry, so an unsafe one escapes nothing -
 * but the archive meant it to, and an unsafe name refuses the archive.
 */
test("an archive carrying a hostile directory entry is refused rather than skipped", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/bundle.zip",
    "application/zip",
    zipSync({ "../../etc/": encode(""), "fine.txt": encode("kept") }),
    8,
    null,
    {},
  );
  const failed = requireFailed(outcome.response);
  assert.match(failed.error, /its entry \\"\.\.\/\.\.\/etc\/\\" cannot be stored as a file/u);
  assert.equal(outcome.uploads.length, 0);
});

/**
 * The entry a user could not have seen. An end-of-central-directory record
 * declaring one record is all it takes: every archive tool lists `a.csv` alone,
 * while `hidden.csv` is stored and would become a derivative the agent reads.
 * Both lists are already in hand per name, so the archive is refused on the
 * difference rather than only where the two overlap.
 */
test("an archive storing an entry its central directory does not list is refused", async (): Promise<void> => {
  const archive = withDeclaredEntryCount(
    zipSync({ "a.csv": encode("declared,and,stored"), "hidden.csv": encode("stored,only") }),
    1,
  );
  const outcome = await prepare("/files/bundle.zip", "application/zip", archive, 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /it stores the entry \\"hidden\.csv\\" that its central directory does not list/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * And the mirror image, which is the same disagreement read the other way: the
 * user was shown two files and the chat would hold a derivative of one, with
 * nothing in the answer saying the other was never there.
 */
test("an archive listing an entry it does not store is refused", async (): Promise<void> => {
  const archive = withoutLastStoredEntry(
    zipSync({ "a.csv": encode("declared,and,stored"), "listed.csv": encode("declared,only") }),
  );
  const outcome = await prepare("/files/bundle.zip", "application/zip", archive, 8, null, {});
  const failed = requireFailed(outcome.response);
  assert.match(
    failed.error,
    /its central directory lists the entry \\"listed\.csv\\" that the archive does not store/u,
  );
  assert.equal(outcome.uploads.length, 0);
});

/**
 * A scanned page, which is the primary shape of a bank statement attachment and
 * which was refused for two years' worth of pages.
 *
 * The image XObject below inflates to 270 MiB, past any byte ceiling a pre-scan
 * would have set for a document, and text extraction never touches it: pdf.js
 * decodes an image only to render one, and nothing here renders. So the page's
 * text comes back in milliseconds while a byte count in front of the parser
 * charged the full 270 MiB and threw - and the caller writes that throw down as
 * a permanent derivatives_error. Measured at 260 such pages: 0.6 s.
 *
 * This test reds any re-added gate that charges a PDF for bytes it does not
 * decode, which is what every byte-counting pre-scan of a PDF does.
 */
test("a PDF whose unread image XObjects dwarf its text is prepared", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/scan.pdf",
    "application/pdf",
    buildScanPagePdf(270 * 1024 * 1024),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.equal(prepared.derivatives.length, 1);
  assert.match(decode(outcome.uploads[0].content), /--- page 1 ---\nStatement page 1/u);
});

/**
 * What a `.xls` from a bank or an ERP actually is, more often than not: an HTML
 * `<table>`, or a TSV, under a name and a media type that say Excel. SheetJS
 * reads both, apps/web/src/lib/chatFiles.ts accepts both under exactly this
 * type, and requiring a ZIP or a CFB container refused them.
 */
test("a workbook that is not a container at all is prepared", async (): Promise<void> => {
  const sources: ReadonlyArray<readonly [string, string]> = [
    ["/files/statement-html.xls", "<html><body><table><tr><td>Date</td><td>Amount</td></tr><tr><td>2026-01-02</td><td>-12.34</td></tr></table></body></html>"],
    ["/files/statement-tsv.xls", "Date\tAmount\n2026-01-02\t-12.34\n"],
  ];
  for (const [path, body] of sources) {
    const outcome = await prepare(path, "application/vnd.ms-excel", encode(body), 4, null, {});
    const prepared = requirePrepared(outcome.response);
    assert.equal(prepared.derivatives.length, 1, `${path} produced no derivative`);
    assert.match(decode(outcome.uploads[0].content), /Date,Amount\n2026-01-02,-12\.34/u);
  }
});

/**
 * The parts a real `.docx` carries that are not WordprocessingML: Word writes
 * EMF and WMF for pasted charts and equations, embeds SVG beside PNG, and
 * stores `word/charts/*.xml`, `word/diagrams/*.xml` and `customXml/*`. Counting
 * `<` bytes across every part to predict what a DOM builder will cost holds for
 * compressed media and collapses for these: a 1 MiB part of nothing but `<`
 * refused a 2,044 byte upload, and a 12.6 MB SVG refused a 31,699 byte one.
 *
 * Both prepare in well under a second, because mammoth parses the part the
 * package's relationships point at and not every part in it.
 */
test("a document package carrying parts that are not WordprocessingML is prepared", async (): Promise<void> => {
  const parts: ReadonlyArray<readonly [string, Uint8Array<ArrayBuffer>]> = [
    ["word/embeddings/chart.bin", new Uint8Array(Buffer.alloc(1024 * 1024, 0x3c))],
    ["word/media/image1.svg", encode(`<svg xmlns="http://www.w3.org/2000/svg">${"<path d='M0 0 L1 1'/>".repeat(600_000)}</svg>`)],
  ];
  for (const [name, content] of parts) {
    const base = unzipSync(buildDocx(["Statement"]));
    base[name] = content;
    const outcome = await prepare(
      "/files/invoice.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      zipSync(base, { level: 9 }),
      4,
      null,
      {},
    );
    const prepared = requirePrepared(outcome.response);
    assert.equal(prepared.derivatives.length, 1, `${name} produced no derivative`);
    // mammoth ends a paragraph with a blank line, so the derivative is the
    // document's one paragraph and the break after it.
    assert.equal(decode(outcome.uploads[0].content), "Statement\n\n");
  }
});

/**
 * And the document that was refused for its own text rather than for its media:
 * 3 MiB of empty paragraphs is 524,258 tag openings, which is the whole of a
 * 524,288 ceiling. A real document reaches that at a few tens of thousands of
 * styled paragraphs, which is a long report rather than an attack.
 */
test("a document package of half a million paragraphs is prepared", async (): Promise<void> => {
  const outcome = await prepare(
    "/files/report.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buildDocx(Array.from({ length: 200_000 }, () => "x")),
    4,
    null,
    {},
  );
  const prepared = requirePrepared(outcome.response);
  assert.equal(prepared.derivatives.length, 1);
  // Two lines per paragraph, mammoth's paragraph break included, and one more
  // for the empty tail after the last of them.
  assert.equal(decode(outcome.uploads[0].content).split("\n").length, 400_001);
});
