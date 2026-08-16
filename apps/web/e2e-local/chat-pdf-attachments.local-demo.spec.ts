import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import {
  PDF_MAXIMUM_PAGE_JPEG_BYTES,
  PDF_MAXIMUM_TOTAL_JPEG_BYTES,
} from "../src/lib/chatPdf";

type PdfRequestPage = Readonly<{
  pageNumber: number;
  text: string;
  jpegBase64Data: string;
}>;

type PdfRequestPart = Readonly<{
  type: "pdf";
  fileName: string;
  mediaType: "application/pdf";
  sourceSha256: string;
  pages: ReadonlyArray<PdfRequestPage>;
  base64Data?: string;
}>;

type CapturedChatRequest = Readonly<{
  content: ReadonlyArray<
    PdfRequestPart | Readonly<{ type: "text"; text: string }>
  >;
}>;

type Deferred<Value> = Readonly<{
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}>;

type RenderedJpegObservation = Readonly<{
  width: number;
  height: number;
  cornerRed: number;
  cornerGreen: number;
  cornerBlue: number;
}>;

type PdfJsAssetObservation = Readonly<{
  path: string;
  status: number;
  origin: string;
  byteLength: number;
}>;

const createDeferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve): void => {
    resolvePromise = resolve;
  });
  if (resolvePromise === null) {
    throw new Error("Failed to create deferred PDF request capture");
  }
  return {
    promise,
    resolve: resolvePromise,
  };
};

const createPdfStreamObject = (
  content: string,
): string =>
  `<< /Length ${String(Buffer.byteLength(content, "latin1"))} >>\nstream\n${content}\nendstream`;

const createTwoPagePdfFixture = (): Buffer => {
  const firstPageContent = [
    "BT",
    "/F1 180 Tf",
    "200 500 Td",
    "(First page amount 42) Tj",
    "ET",
    "BT",
    "/F2 80 Tf",
    "200 200 Td",
    "<0041> Tj",
    "ET",
  ].join("\n");
  const secondPageContent = [
    "BT",
    "/F1 180 Tf",
    "200 500 Td",
    "(Second page total 84) Tj",
    "ET",
  ].join("\n");
  const objects: ReadonlyArray<string> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 1000] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 4 0 R >>",
    createPdfStreamObject(firstPageContent),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 1000] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    createPdfStreamObject(secondPageContent),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [9 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /DW 1000 >>",
  ];
  const header = "%PDF-1.4\n% browser PDF fixture\n";
  const assembled = objects.reduce<Readonly<{
    body: string;
    offsets: ReadonlyArray<number>;
  }>>(
    (current, object, index) => ({
      body: `${current.body}${String(index + 1)} 0 obj\n${object}\nendobj\n`,
      offsets: [
        ...current.offsets,
        Buffer.byteLength(current.body, "latin1"),
      ],
    }),
    { body: header, offsets: [] },
  );
  const xrefOffset = Buffer.byteLength(assembled.body, "latin1");
  const xrefEntries = assembled.offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n");
  return Buffer.from([
    assembled.body,
    `xref\n0 ${String(objects.length + 1)}\n`,
    "0000000000 65535 f \n",
    `${xrefEntries}\n`,
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n`,
    `startxref\n${String(xrefOffset)}\n%%EOF\n`,
  ].join(""), "latin1");
};

const mockWorkspaceClientDependencies = async (
  page: Page,
): Promise<void> => {
  await page.route("**/api/categories", async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });
  await page.route(
    "**/api/workspace-settings",
    async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ filteredCategories: null }),
      });
    },
  );
};

test("converts a real PDF into one ordered logical browser attachment", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const pdfBytes = createTwoPagePdfFixture();
  const capturedRequest = createDeferred<CapturedChatRequest>();
  await mockWorkspaceClientDependencies(page);
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    capturedRequest.resolve(
      route.request().postDataJSON() as CapturedChatRequest,
    );
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": "session-pdf-browser-preprocessing",
      },
      body: [
        "data: {\"type\":\"session\",\"sessionId\":\"session-pdf-browser-preprocessing\"}",
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();

  const representativeAssetResponses = await page.evaluate(async (
    assetPaths: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<PdfJsAssetObservation>> =>
    Promise.all(assetPaths.map(async (path) => {
      const response = await fetch(path);
      const responseBytes = await response.arrayBuffer();
      return {
        path,
        status: response.status,
        origin: new URL(response.url).origin,
        byteLength: responseBytes.byteLength,
      };
    })), [
    "/pdfjs-assets/wasm/openjpeg.wasm",
    "/pdfjs-assets/standard_fonts/FoxitSymbol.pfb",
    "/pdfjs-assets/iccs/CGATS001Compat-v2-micro.icc",
  ]);
  expect(representativeAssetResponses.map(({ path, status, origin: assetOrigin }) => ({
    path,
    status,
    origin: assetOrigin,
  }))).toEqual([
    {
      path: "/pdfjs-assets/wasm/openjpeg.wasm",
      status: 200,
      origin: origin.origin,
    },
    {
      path: "/pdfjs-assets/standard_fonts/FoxitSymbol.pfb",
      status: 200,
      origin: origin.origin,
    },
    {
      path: "/pdfjs-assets/iccs/CGATS001Compat-v2-micro.icc",
      status: 200,
      origin: origin.origin,
    },
  ]);
  for (const assetResponse of representativeAssetResponses) {
    expect(assetResponse.byteLength).toBeGreaterThan(0);
  }
  const cMapResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname
      === "/pdfjs-assets/cmaps/UniJIS-UTF16-H.bcmap");

  await page.getByTestId("chat-file-input").setInputFiles({
    name: "two-page-statement.pdf",
    mimeType: "application/pdf",
    buffer: pdfBytes,
  });
  const preparedAttachment = page.getByTestId("chat-prepared-attachment");
  await expect(preparedAttachment).toHaveCount(1, { timeout: 20_000 });
  await expect(preparedAttachment).toHaveAttribute(
    "data-media-type",
    "application/pdf",
  );
  await expect(preparedAttachment).toContainText("two-page-statement.pdf");
  const cMapResponse = await cMapResponsePromise;
  expect(cMapResponse.status()).toBe(200);
  expect(new URL(cMapResponse.url()).origin).toBe(origin.origin);

  await page.getByTestId("chat-composer-input").fill("Import this statement");
  await page.getByTestId("chat-submit").click();
  const request = await capturedRequest.promise;
  const pdfParts = request.content.filter(
    (part): part is PdfRequestPart => part.type === "pdf",
  );
  expect(pdfParts).toHaveLength(1);
  const pdfPart = pdfParts[0];
  if (pdfPart === undefined) {
    throw new Error("Logical PDF request part was not captured");
  }

  expect(pdfPart.fileName).toBe("two-page-statement.pdf");
  expect(pdfPart.mediaType).toBe("application/pdf");
  expect(pdfPart.sourceSha256).toBe(
    createHash("sha256").update(pdfBytes).digest("hex"),
  );
  expect(request.content.map((part) => part.type)).toEqual(["pdf", "text"]);
  expect(Object.hasOwn(pdfPart, "base64Data")).toBe(false);
  expect(JSON.stringify(request)).not.toContain(pdfBytes.toString("base64"));
  expect(pdfPart.pages.map((pdfPage) => pdfPage.pageNumber)).toEqual([1, 2]);
  expect(pdfPart.pages[0]?.text).toContain("First page amount 42");
  expect(pdfPart.pages[1]?.text).toContain("Second page total 84");

  const jpegByteLengths = pdfPart.pages.map((pdfPage) => {
    const jpegBytes = Buffer.from(pdfPage.jpegBase64Data, "base64");
    expect([...jpegBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(jpegBytes.byteLength).toBeLessThanOrEqual(
      PDF_MAXIMUM_PAGE_JPEG_BYTES,
    );
    return jpegBytes.byteLength;
  });
  expect(jpegByteLengths.reduce((total, bytes) => total + bytes, 0))
    .toBeLessThanOrEqual(PDF_MAXIMUM_TOTAL_JPEG_BYTES);

  const renderedPages = await page.evaluate(async (
    encodedPages: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<RenderedJpegObservation>> => {
    const observations: Array<RenderedJpegObservation> = [];
    for (const encodedPage of encodedPages) {
      const image = new Image();
      await new Promise<void>((resolve, reject): void => {
        image.onload = (): void => resolve();
        image.onerror = (): void => reject(new Error("Failed to decode rendered PDF page JPEG"));
        image.src = `data:image/jpeg;base64,${encodedPage}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context2d = canvas.getContext("2d");
      if (context2d === null) {
        throw new Error("Canvas 2D context is unavailable in PDF browser test");
      }
      context2d.drawImage(image, 0, 0);
      const corner = context2d.getImageData(0, 0, 1, 1).data;
      observations.push({
        width: image.naturalWidth,
        height: image.naturalHeight,
        cornerRed: corner[0] ?? 0,
        cornerGreen: corner[1] ?? 0,
        cornerBlue: corner[2] ?? 0,
      });
    }
    return observations;
  }, pdfPart.pages.map((pdfPage) => pdfPage.jpegBase64Data));

  expect(renderedPages.map(({ width, height }) => [width, height])).toEqual([
    [1600, 800],
    [800, 1600],
  ]);
  for (const renderedPage of renderedPages) {
    expect(Math.max(renderedPage.width, renderedPage.height))
      .toBeLessThanOrEqual(1600);
    expect(renderedPage.cornerRed).toBeGreaterThanOrEqual(245);
    expect(renderedPage.cornerGreen).toBeGreaterThanOrEqual(245);
    expect(renderedPage.cornerBlue).toBeGreaterThanOrEqual(245);
  }
});
