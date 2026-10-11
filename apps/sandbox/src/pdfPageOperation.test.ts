import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import {
  SANDBOX_PDF_PAGE_MAX_BYTES,
  type ChatSandboxPdfPageResponse,
} from "./contract.js";
import {
  hashObjectContent,
  ObjectTransferError,
  type SandboxObjectTransfer,
} from "./objects.js";
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
  // And the one thing the library's own message does not say: that no retry of
  // this can work. The kinds that are worth another attempt and the kinds that
  // are not must not read alike.
  assert.match(response.error, /Asking for it again cannot change this/u);
});

/**
 * Read one page over a transfer that fails the way the caller chooses.
 *
 * The PDF is real and the page number is valid, so a case that stopped
 * classifying the read cannot pass by answering something else: the only
 * answers reachable are the read's own.
 */
const readPageOverFailingRead = async (
  error: unknown,
): Promise<ChatSandboxPdfPageResponse> => {
  const bytes = await buildSizedPdf();
  const path = "/files/statement.pdf";

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
      page: 1,
    },
    {
      readObject: (): Promise<Uint8Array> => Promise.reject(error),
      writeObject: async (): Promise<void> => {
        throw new Error("pdf_page writes nothing");
      },
    },
  );
};

/**
 * A failed read, answered with the advice its kind gets everywhere else.
 *
 * This operation reads a /files original over the same transfer, classified by
 * the same classifyObjectReadFailure, as a `bash` command and a /work seed do -
 * and it was the one of the three that said only "page 1 could not be read:"
 * followed by whatever HTTP status came back. A model given that has no next
 * step: it cannot tell a transient 503 from a file it will never read, so it
 * either gives up on real data or retries something that cannot work.
 *
 * Each case reds the blanket catch this operation had around the read, which
 * answered with the library's message and no advice at all.
 */
const READ_FAILURES: ReadonlyArray<Readonly<{ label: string; error: Error; advice: RegExp }>> = [
  {
    label: "a 5xx outlived all three attempts",
    error: new ObjectTransferError("Pre-signed object read failed with HTTP 503: SlowDown", 503),
    advice: /asking for it again is worth one attempt/u,
  },
  {
    label: "storage answered nothing at all",
    error: new ObjectTransferError("Pre-signed object read failed: socket closed", null),
    advice: /This is transient, so ask for it again/u,
  },
];

/**
 * And the read failure that is this sandbox's own, which must not be answered.
 *
 * The asymmetry that was wrong: `prepare` raised a bug of its own in the read
 * phase while this operation answered one, through the same
 * classifyObjectReadFailure and over the same transfer. `unknown` is the kind a
 * TypeError with no cause gets, and its advice tells the model the file exists
 * and the read failed - so a dereference here reported a healthy PDF as
 * unreadable, on invocations that all report success, with no Errors datapoint
 * and nothing in any log saying otherwise.
 *
 * No cause, which is the discriminator and not a detail: with one this is a
 * dropped socket, and the cases above are exactly that.
 *
 * It reds the first catch without its defect check.
 */
test("a page whose read failed on this workspace's own TypeError is raised", async (): Promise<void> => {
  const error = new TypeError("Cannot read properties of undefined (reading 'byteLength')");
  await assert.rejects(readPageOverFailingRead(error), (raised: unknown) => {
    assert.equal(raised, error, "the failure an operator has to see was answered instead");

    return true;
  });
});

for (const { label, error, advice } of READ_FAILURES) {
  test(`a page whose read failed because ${label} is answered with its next step`, async (): Promise<void> => {
    const response = await readPageOverFailingRead(error);
    assert.equal(response.status, "failed");
    assert.ok(response.status === "failed");
    assert.match(response.error, /"\/files\/statement\.pdf" exists/u);
    assert.match(response.error, advice);
    // The reason itself still travels, quoted, because the advice names a kind
    // and not a status.
    assert.match(response.error, /Pre-signed object read failed/u);
  });
}

/**
 * The pdf-lib this build either carries or does not, which is the one failure
 * here that is not about this document.
 *
 * It fails every PDF of the deployment, forever, on invocations that all report
 * success: no Errors datapoint, no `action: "error"`, not even a
 * derivatives_error row, because this operation stores nothing. The model is
 * simply told page 1 could not be read, and nothing anywhere records that the
 * bundle is broken. So it is raised - the only channel it has - and the model
 * loses nothing by it, because no retry of a bundling defect succeeds.
 *
 * The library is replaced by a module that throws what esbuild's shim throws,
 * through a data URL so it cannot collide with the real module in the loader
 * cache. It reds the unwrapped `await import("pdf-lib")`, which answered this
 * as a property of the page.
 */
test("a pdf-lib this build cannot load is raised rather than answered", async (): Promise<void> => {
  const document = await buildSizedPdf();
  const stub = "throw new Error('Dynamic require of \"url\" is not supported');\n";
  const hooks = registerHooks({
    resolve: (specifier, context, next) => specifier === "pdf-lib"
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : next(specifier, context),
  });
  try {
    await assert.rejects(readPage(document, 1), (raised: unknown) => {
      assert.ok(raised instanceof Error);
      assert.equal(raised.name, "ConversionLibraryError");
      assert.match(raised.message, /could not load the 'pdf-lib' library/u);
      assert.match(raised.message, /defect of this build rather than a property of any source/u);

      return true;
    });
  } finally {
    hooks.deregister();
  }

  // And the same page comes back with the real library, so this proves the
  // classification rather than a fixture that was never readable.
  requireRendered(await readPage(document, 1));
});
