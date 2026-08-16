"use client";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  PDF_INITIAL_JPEG_QUALITY,
  PDF_MAXIMUM_ENCODE_ATTEMPTS,
  PDF_MAXIMUM_FILENAME_CHARACTERS,
  PDF_MAXIMUM_LONG_EDGE,
  PDF_MAXIMUM_PAGE_COUNT,
  PDF_MAXIMUM_PAGE_TEXT_CHARACTERS,
  PDF_MAXIMUM_SOURCE_BYTES,
  PDF_MAXIMUM_TOTAL_JPEG_BYTES,
  PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS,
  PDF_MEDIA_TYPE,
  PDF_MINIMUM_JPEG_QUALITY,
  calculatePdfPageOutputBudget,
  hasPdfSignature,
} from "@/lib/chatPdf";
import type {
  PdfContentPart,
  PdfPageContent,
} from "@/server/chat/types";
import {
  ImageOutputTooLargeError,
  encodeCanvasImageAsJpeg,
  type ImagePreprocessingConstraints,
} from "./imagePreprocessing";

const PDF_WORKER_URL = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();
const PDFJS_ASSET_BASE_URL = "/pdfjs-assets";
const PDFJS_CMAP_URL = `${PDFJS_ASSET_BASE_URL}/cmaps/`;
const PDFJS_WASM_URL = `${PDFJS_ASSET_BASE_URL}/wasm/`;
const PDFJS_STANDARD_FONT_DATA_URL = `${PDFJS_ASSET_BASE_URL}/standard_fonts/`;
const PDFJS_ICC_URL = `${PDFJS_ASSET_BASE_URL}/iccs/`;

export type PdfPreparationProgress = Readonly<{
  pageNumber: number;
  totalPages: number;
}>;

export type PdfPreparationProgressCallback = (
  progress: PdfPreparationProgress,
) => void;

export class PdfReadError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to read PDF "${fileName}": ${reason}`);
    this.name = "PdfReadError";
  }
}

export class PdfSignatureError extends Error {
  public constructor(fileName: string) {
    super(`PDF "${fileName}" does not begin with a valid %PDF- signature.`);
    this.name = "PdfSignatureError";
  }
}

export class PdfEncryptedError extends Error {
  public constructor(fileName: string) {
    super(`PDF "${fileName}" is encrypted or password protected.`);
    this.name = "PdfEncryptedError";
  }
}

export class PdfPageLimitError extends Error {
  public constructor(fileName: string, pageCount: number) {
    super(
      `PDF "${fileName}" has ${String(pageCount)} pages; the maximum is ${String(PDF_MAXIMUM_PAGE_COUNT)}.`,
    );
    this.name = "PdfPageLimitError";
  }
}

export class PdfTextLimitError extends Error {
  public readonly pageNumber: number;

  public constructor(fileName: string, pageNumber: number, characterCount: number) {
    super(
      `PDF "${fileName}" page ${String(pageNumber)} produces ${String(characterCount)} extracted-text characters, exceeding the bounded PDF text limits.`,
    );
    this.name = "PdfTextLimitError";
    this.pageNumber = pageNumber;
  }
}

export class PdfOutputLimitError extends Error {
  public readonly pageNumber: number;

  public constructor(fileName: string, pageNumber: number, maximumOutputBytes: number) {
    super(
      `PDF "${fileName}" page ${String(pageNumber)} could not be encoded within its ${String(maximumOutputBytes)}-byte JPEG budget.`,
    );
    this.name = "PdfOutputLimitError";
    this.pageNumber = pageNumber;
  }
}

export class PdfDecodeError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to parse PDF "${fileName}": ${reason}`);
    this.name = "PdfDecodeError";
  }
}

export class PdfPageProcessingError extends Error {
  public readonly pageNumber: number;

  public constructor(fileName: string, pageNumber: number, reason: string) {
    super(
      `Failed to process PDF "${fileName}" page ${String(pageNumber)}: ${reason}`,
    );
    this.name = "PdfPageProcessingError";
    this.pageNumber = pageNumber;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const bytesToHex = (
  bytes: Uint8Array,
): string =>
  [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const readPdfBytes = async (
  file: File,
): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw new PdfReadError(file.name, errorMessage(error));
  }
};

const calculateSourceSha256 = async (
  bytes: Uint8Array,
): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
};

const extractPdfPageText = async (
  page: PDFPageProxy,
): Promise<string> => {
  const content = await page.getTextContent();
  return content.items
    .filter((item) => "str" in item)
    .map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`)
    .join("")
    .trim();
};

const renderPdfPage = async (
  page: PDFPageProxy,
  fileName: string,
  pageNumber: number,
): Promise<HTMLCanvasElement> => {
  const unscaledViewport = page.getViewport({ scale: 1, rotation: page.rotate });
  const longEdge = Math.max(unscaledViewport.width, unscaledViewport.height);
  const scale = longEdge > PDF_MAXIMUM_LONG_EDGE
    ? PDF_MAXIMUM_LONG_EDGE / longEdge
    : 1;
  const viewport = page.getViewport({ scale, rotation: page.rotate });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(
    1,
    Math.min(PDF_MAXIMUM_LONG_EDGE, Math.ceil(viewport.width)),
  );
  canvas.height = Math.max(
    1,
    Math.min(PDF_MAXIMUM_LONG_EDGE, Math.ceil(viewport.height)),
  );
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new PdfPageProcessingError(
      fileName,
      pageNumber,
      "Canvas 2D context is unavailable",
    );
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas,
    canvasContext: context,
    viewport,
    background: "#ffffff",
  }).promise;
  return canvas;
};

const releaseCanvas = (
  canvas: HTMLCanvasElement,
): void => {
  canvas.width = 1;
  canvas.height = 1;
};

const createPdfPageImageConstraints = (
  maximumOutputBytes: number,
): ImagePreprocessingConstraints => ({
  maximumSourceBytes: PDF_MAXIMUM_SOURCE_BYTES,
  maximumLongEdge: PDF_MAXIMUM_LONG_EDGE,
  initialJpegQuality: PDF_INITIAL_JPEG_QUALITY,
  minimumJpegQuality: PDF_MINIMUM_JPEG_QUALITY,
  maximumOutputBytes,
  maximumEncodeAttempts: PDF_MAXIMUM_ENCODE_ATTEMPTS,
});

const processPdfPage = async (
  documentProxy: PDFDocumentProxy,
  fileName: string,
  pageNumber: number,
  maximumOutputBytes: number,
): Promise<PdfPageContent & Readonly<{ jpegByteLength: number }>> => {
  let page: PDFPageProxy | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    page = await documentProxy.getPage(pageNumber);
    const text = await extractPdfPageText(page);
    if (text.length > PDF_MAXIMUM_PAGE_TEXT_CHARACTERS) {
      throw new PdfTextLimitError(fileName, pageNumber, text.length);
    }

    canvas = await renderPdfPage(page, fileName, pageNumber);
    const encoded = await encodeCanvasImageAsJpeg(
      canvas,
      { width: canvas.width, height: canvas.height },
      `${fileName} page ${String(pageNumber)}`,
      createPdfPageImageConstraints(maximumOutputBytes),
      "#ffffff",
    );
    return {
      pageNumber,
      text,
      jpegBase64Data: encoded.base64Data,
      jpegByteLength: encoded.byteLength,
    };
  } catch (error) {
    if (
      error instanceof PdfTextLimitError
      || error instanceof PdfPageProcessingError
    ) {
      throw error;
    }
    if (error instanceof ImageOutputTooLargeError) {
      throw new PdfOutputLimitError(fileName, pageNumber, maximumOutputBytes);
    }
    throw new PdfPageProcessingError(
      fileName,
      pageNumber,
      errorMessage(error),
    );
  } finally {
    page?.cleanup();
    if (canvas !== null) {
      releaseCanvas(canvas);
    }
  }
};

const loadPdfDocument = async (
  fileName: string,
  sourceBytes: Uint8Array,
): Promise<Readonly<{
  documentProxy: PDFDocumentProxy;
  destroy: () => Promise<void>;
}>> => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
  const loadingTask = pdfjs.getDocument({
    data: sourceBytes,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    wasmUrl: PDFJS_WASM_URL,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    iccUrl: PDFJS_ICC_URL,
  });
  const passwordRequired = new Promise<never>((_resolve, reject): void => {
    loadingTask.onPassword = (): void => {
      reject(new PdfEncryptedError(fileName));
    };
  });

  try {
    const documentProxy = await Promise.race([
      loadingTask.promise,
      passwordRequired,
    ]);
    return {
      documentProxy,
      destroy: async (): Promise<void> => {
        await documentProxy.destroy();
      },
    };
  } catch (error) {
    await loadingTask.destroy();
    if (error instanceof PdfEncryptedError || error instanceof pdfjs.PasswordException) {
      throw new PdfEncryptedError(fileName);
    }
    throw new PdfDecodeError(fileName, errorMessage(error));
  }
};

export const preprocessPdfAttachment = async (
  file: File,
  onProgress: PdfPreparationProgressCallback,
): Promise<PdfContentPart> => {
  if (file.size > PDF_MAXIMUM_SOURCE_BYTES) {
    throw new RangeError(
      `PDF "${file.name}" is ${String(file.size)} bytes; the maximum is ${String(PDF_MAXIMUM_SOURCE_BYTES)} bytes.`,
    );
  }
  if (
    file.name.trim().length === 0
    || Array.from(file.name).length > PDF_MAXIMUM_FILENAME_CHARACTERS
  ) {
    throw new PdfDecodeError(
      file.name,
      `filename must contain 1-${String(PDF_MAXIMUM_FILENAME_CHARACTERS)} characters`,
    );
  }

  const sourceBytes = await readPdfBytes(file);
  if (!hasPdfSignature(sourceBytes)) {
    throw new PdfSignatureError(file.name);
  }
  const sourceSha256 = await calculateSourceSha256(sourceBytes);
  const loadedDocument = await loadPdfDocument(file.name, sourceBytes);

  try {
    const pageCount = loadedDocument.documentProxy.numPages;
    if (
      !Number.isSafeInteger(pageCount)
      || pageCount < 1
      || pageCount > PDF_MAXIMUM_PAGE_COUNT
    ) {
      throw new PdfPageLimitError(file.name, pageCount);
    }

    const pages: Array<PdfPageContent> = [];
    let totalJpegBytes = 0;
    let totalTextCharacters = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      onProgress({ pageNumber, totalPages: pageCount });
      const maximumOutputBytes = calculatePdfPageOutputBudget(
        PDF_MAXIMUM_TOTAL_JPEG_BYTES - totalJpegBytes,
        pageCount - pageNumber + 1,
      );
      const page = await processPdfPage(
        loadedDocument.documentProxy,
        file.name,
        pageNumber,
        maximumOutputBytes,
      );
      totalJpegBytes += page.jpegByteLength;
      totalTextCharacters += page.text.length;
      if (totalJpegBytes > PDF_MAXIMUM_TOTAL_JPEG_BYTES) {
        throw new PdfOutputLimitError(file.name, pageNumber, maximumOutputBytes);
      }
      if (totalTextCharacters > PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS) {
        throw new PdfTextLimitError(file.name, pageNumber, totalTextCharacters);
      }
      pages.push({
        pageNumber: page.pageNumber,
        text: page.text,
        jpegBase64Data: page.jpegBase64Data,
      });
    }

    return {
      type: "pdf",
      fileName: file.name,
      mediaType: PDF_MEDIA_TYPE,
      sourceSha256,
      pages,
    };
  } finally {
    await loadedDocument.destroy();
  }
};
