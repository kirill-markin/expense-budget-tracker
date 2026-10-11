import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import {
  SANDBOX_PDF_PAGE_MAX_BYTES,
  type ChatSandboxPdfPageResponse,
} from "./contract.js";
import { hashObjectContent, type SandboxObjectTransfer } from "./objects.js";
import { extractPdfPage } from "./pdfPageOperation.js";

const HOST = "objects.example";

/**
 * A Lambda RequestResponse payload, which is what the page has to travel
 * through and the only reason this operation has a cap at all.
 */
const LAMBDA_SYNCHRONOUS_RESPONSE_BYTES = 6 * 1024 * 1024;

const readPage = async (
  bytes: Uint8Array,
  page: number,
): Promise<ChatSandboxPdfPageResponse> => {
  const path = "/files/statement.pdf";
  const transfer: SandboxObjectTransfer = {
    readObject: async (getUrl: string): Promise<Uint8Array> => {
      assert.equal(getUrl, `https://${HOST}${path}`);

      return bytes;
    },
    writeObject: async (): Promise<void> => {
      throw new Error("pdf_page writes nothing");
    },
  };

  return extractPdfPage(
    {
      operation: "pdf_page",
      source: {
        path,
        mediaType: "application/pdf",
        sizeBytes: bytes.byteLength,
        sha256: hashObjectContent(bytes),
        mtimeMs: 1_700_000_000_000,
        getUrl: `https://${HOST}${path}`,
      },
      page,
    },
    transfer,
  );
};

const requireRendered = (
  response: ChatSandboxPdfPageResponse,
): Extract<ChatSandboxPdfPageResponse, { status: "rendered" }> => {
  assert.equal(response.status, "rendered", `expected a rendered page, got ${JSON.stringify(response).slice(0, 300)}`);
  assert.ok(response.status === "rendered");

  return response;
};

/**
 * Pages of three different sizes, so which page came back is a measurable fact
 * rather than something the test has to take on trust.
 */
const PAGE_SIZES: ReadonlyArray<readonly [number, number]> = [[595, 842], [400, 500], [300, 300]];

const buildSizedPdf = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create();
  for (const [width, height] of PAGE_SIZES) {
    document.addPage([width, height]);
  }

  return document.save();
};

/** One PNG chunk, length and CRC included, as the format requires. */
const pngChunk = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length, 0);
  header.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), body])) >>> 0, 0);

  return Buffer.concat([header, body, checksum]);
};

/**
 * A real PNG of random pixels, which is the one image a page can carry that no
 * compression step can shrink: the worst case the response cap exists for, and
 * the shape of a page-sized scan.
 */
const buildRandomPng = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.of(0), randomBytes(width * 3)])),
  );

  return Buffer.concat([
    Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

test("the requested page comes back as a one-page PDF of its own", async (): Promise<void> => {
  const rendered = requireRendered(await readPage(await buildSizedPdf(), 2));
  assert.equal(rendered.page, 2);
  assert.equal(rendered.pageCount, PAGE_SIZES.length);
  const returned = await PDFDocument.load(Buffer.from(rendered.pdfBase64, "base64"));
  assert.equal(returned.getPageCount(), 1);
  // The second page's own size, which is what proves the page number was not
  // read off by one.
  const size = returned.getPage(0).getSize();
  assert.deepEqual([Math.round(size.width), Math.round(size.height)], [400, 500]);
  assert.equal(rendered.sizeBytes, Buffer.from(rendered.pdfBase64, "base64").byteLength);
});

/**
 * The page number is the model's, so a page past the end is something to be
 * told. Raising instead would reach the caller as a dead invocation, and a
 * single such log record pages on its own.
 */
test("a page outside the document is answered with the page count, not raised", async (): Promise<void> => {
  const document = await buildSizedPdf();
  for (const page of [9, 0, -1]) {
    const response = await readPage(document, page);
    assert.equal(response.status, "failed");
    assert.ok(response.status === "failed");
    assert.match(
      response.error,
      new RegExp(`has 3 pages, so page ${String(page)} is not one of them`, "u"),
    );
  }
});

/**
 * A text page is the ordinary case and it is tiny; the cap is nowhere near it.
 * Measured here rather than asserted in prose, because the whole justification
 * for the number is the distance between the two.
 */
test("an ordinary statement page is far inside the response limit", async (): Promise<void> => {
  const rendered = requireRendered(await readPage(await buildSizedPdf(), 1));
  assert.ok(
    rendered.pdfBase64.length < LAMBDA_SYNCHRONOUS_RESPONSE_BYTES / 10,
    `a text page took ${String(rendered.pdfBase64.length)} base64 characters`,
  );
});

/**
 * And the case that makes the cap necessary: one page carrying a full-page
 * incompressible image is 3.9 MB, which is 5.2 MB of base64 - inside the 6 MB
 * payload limit by less than the rest of a response needs.
 */
test("a page too large to return is refused with its size", async (): Promise<void> => {
  const document = await PDFDocument.create();
  const image = await document.embedPng(buildRandomPng(1300, 1000));
  for (let page = 0; page < 2; page += 1) {
    document.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
  }
  const response = await readPage(await document.save(), 2);
  assert.equal(response.status, "failed");
  assert.ok(response.status === "failed");
  assert.match(
    response.error,
    new RegExp(`past the ${String(SANDBOX_PDF_PAGE_MAX_BYTES)} bytes one page may be returned as`, "u"),
  );
});

test("a source whose bytes do not match the row's digest is refused", async (): Promise<void> => {
  const bytes = await buildSizedPdf();
  const path = "/files/statement.pdf";
  const response = await extractPdfPage(
    {
      operation: "pdf_page",
      source: {
        path,
        mediaType: "application/pdf",
        sizeBytes: bytes.byteLength,
        sha256: "c".repeat(64),
        mtimeMs: 1_700_000_000_000,
        getUrl: `https://${HOST}${path}`,
      },
      page: 1,
    },
    {
      readObject: async (): Promise<Uint8Array> => bytes,
      writeObject: async (): Promise<void> => {
        throw new Error("pdf_page writes nothing");
      },
    },
  );
  assert.equal(response.status, "failed");
  assert.ok(response.status === "failed");
  assert.match(response.error, /has sha256 [0-9a-f]{64}, expected c{64}/u);
});
