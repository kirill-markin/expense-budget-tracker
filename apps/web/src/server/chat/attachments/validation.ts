import {
  MAX_HEIC_FTYP_BOX_BYTES,
  OPENAI_IMAGE_MIME_TYPES,
  detectOpenAIImageMimeType,
  hasHeicFileSignature,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  normalizeOpenAIImageMimeType,
} from "@/lib/chatImageFormats";
import type { OpenAIImageMimeType } from "@/lib/chatImageFormats";
import {
  PDF_MAXIMUM_FILENAME_CHARACTERS,
  PDF_MAXIMUM_PAGE_COUNT,
  PDF_MAXIMUM_PAGE_JPEG_BYTES,
  PDF_MAXIMUM_PAGE_TEXT_CHARACTERS,
  PDF_MAXIMUM_TOTAL_JPEG_BYTES,
  PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS,
  PDF_MEDIA_TYPE,
  getBase64DecodedByteLength,
  isLegacyRawPdfFilePart,
  isSha256Hex,
} from "@/lib/chatPdf";
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
  PdfContentPart,
} from "@/server/chat/types";

const IMAGE_SIGNATURE_BYTE_COUNT = MAX_HEIC_FTYP_BOX_BYTES;
const BASE64_PREFIX_CHARACTER_COUNT = Math.ceil(IMAGE_SIGNATURE_BYTE_COUNT / 3) * 4;

type DetectedImageMimeType = OpenAIImageMimeType | "image/heic";
type HeicDetectionMethod = "claimed MIME" | "filename extension" | "file signature";

const formatContentPartContext = (
  partIndex: number,
  mediaType: string,
  fileName: string | null,
): string => {
  const fileNameContext = fileName === null ? "" : `, filename ${JSON.stringify(fileName)}`;
  return `Content part ${partIndex} (claimed MIME ${JSON.stringify(mediaType)}${fileNameContext})`;
};

export class InvalidBase64ImageDataError extends Error {
  public constructor(partIndex: number, mediaType: string) {
    super(
      `${formatContentPartContext(partIndex, mediaType, null)} contains invalid base64 image data.`,
    );
    this.name = "InvalidBase64ImageDataError";
  }
}

export class UnsupportedImageMediaTypeError extends Error {
  public constructor(partIndex: number, mediaType: string) {
    super(
      `${formatContentPartContext(partIndex, mediaType, null)} uses an unsupported image media type. `
      + `Supported media types: ${OPENAI_IMAGE_MIME_TYPES.join(", ")}. Convert HEIC/HEIF images before upload.`,
    );
    this.name = "UnsupportedImageMediaTypeError";
  }
}

export class ImageMimeSignatureMismatchError extends Error {
  public constructor(
    partIndex: number,
    mediaType: string,
    detectedMediaType: DetectedImageMimeType | null,
  ) {
    const mismatch = detectedMediaType === null
      ? "does not have a recognized supported image signature"
      : `has a ${detectedMediaType} signature that does not match the claimed MIME`;
    super(`${formatContentPartContext(partIndex, mediaType, null)} ${mismatch}.`);
    this.name = "ImageMimeSignatureMismatchError";
  }
}

export class HeicFileAttachmentError extends Error {
  public constructor(
    partIndex: number,
    mediaType: string,
    fileName: string,
    detectionMethod: HeicDetectionMethod,
  ) {
    super(
      `${formatContentPartContext(partIndex, mediaType, fileName)} is an unsupported HEIC/HEIF image `
      + `submitted as a generic file (${detectionMethod}). Convert it to JPEG, PNG, WebP, or GIF before upload.`,
    );
    this.name = "HeicFileAttachmentError";
  }
}

export class LegacyPdfFileAttachmentError extends Error {
  public constructor(partIndex: number, mediaType: string, fileName: string) {
    super(
      `${formatContentPartContext(partIndex, mediaType, fileName)} contains a raw PDF. `
      + "Raw PDFs are not accepted; attach the PDF again so the browser can convert every page to extracted text and JPEG.",
    );
    this.name = "LegacyPdfFileAttachmentError";
  }
}

export class InvalidPdfAttachmentError extends Error {
  public constructor(partIndex: number, fileName: string, reason: string) {
    super(
      `Content part ${String(partIndex)} (PDF filename ${JSON.stringify(fileName)}) is invalid: ${reason}`,
    );
    this.name = "InvalidPdfAttachmentError";
  }
}

const isBase64DataCharacter = (characterCode: number): boolean =>
  (characterCode >= 0x41 && characterCode <= 0x5a)
  || (characterCode >= 0x61 && characterCode <= 0x7a)
  || (characterCode >= 0x30 && characterCode <= 0x39)
  || characterCode === 0x2b
  || characterCode === 0x2f;

const hasValidBase64Shape = (value: string): boolean => {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - paddingLength;
  for (let index = 0; index < dataLength; index += 1) {
    if (!isBase64DataCharacter(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
};

const decodeBase64Prefix = (value: string): Uint8Array =>
  Uint8Array.from(
    Buffer.from(value.slice(0, BASE64_PREFIX_CHARACTER_COUNT), "base64")
      .subarray(0, IMAGE_SIGNATURE_BYTE_COUNT),
  );

const decodeTolerantBase64Prefix = (value: string): Uint8Array => {
  let encodedPrefix = "";
  for (
    let index = 0;
    index < value.length && encodedPrefix.length < BASE64_PREFIX_CHARACTER_COUNT;
    index += 1
  ) {
    const characterCode = value.charCodeAt(index);
    if (characterCode === 0x3d) {
      break;
    }
    if (isBase64DataCharacter(characterCode)) {
      encodedPrefix += value[index];
    }
  }
  return Uint8Array.from(
    Buffer.from(encodedPrefix, "base64").subarray(0, IMAGE_SIGNATURE_BYTE_COUNT),
  );
};

const validateImagePart = (
  part: ImageContentPart,
  partIndex: number,
): void => {
  const normalizedMediaType = normalizeOpenAIImageMimeType(part.mediaType);
  if (normalizedMediaType === null) {
    throw new UnsupportedImageMediaTypeError(partIndex, part.mediaType);
  }

  if (!hasValidBase64Shape(part.base64Data)) {
    throw new InvalidBase64ImageDataError(partIndex, part.mediaType);
  }

  const prefix = decodeBase64Prefix(part.base64Data);
  if (hasHeicFileSignature(prefix)) {
    throw new ImageMimeSignatureMismatchError(partIndex, part.mediaType, "image/heic");
  }

  const detectedMediaType = detectOpenAIImageMimeType(prefix);
  if (detectedMediaType !== normalizedMediaType) {
    throw new ImageMimeSignatureMismatchError(partIndex, part.mediaType, detectedMediaType);
  }
};

const validateFilePart = (
  part: FileContentPart,
  partIndex: number,
): void => {
  if (isLegacyRawPdfFilePart(part)) {
    throw new LegacyPdfFileAttachmentError(
      partIndex,
      part.mediaType,
      part.fileName,
    );
  }

  if (normalizeHeicImageMimeType(part.mediaType) !== null) {
    throw new HeicFileAttachmentError(
      partIndex,
      part.mediaType,
      part.fileName,
      "claimed MIME",
    );
  }

  if (isHeicFileExtension(part.fileName)) {
    throw new HeicFileAttachmentError(
      partIndex,
      part.mediaType,
      part.fileName,
      "filename extension",
    );
  }

  if (hasHeicFileSignature(decodeTolerantBase64Prefix(part.base64Data))) {
    throw new HeicFileAttachmentError(
      partIndex,
      part.mediaType,
      part.fileName,
      "file signature",
    );
  }
};

const validatePdfPart = (
  part: PdfContentPart,
  partIndex: number,
): void => {
  const fileNameLength = Array.from(part.fileName).length;
  if (
    part.fileName.trim().length === 0
    || fileNameLength > PDF_MAXIMUM_FILENAME_CHARACTERS
  ) {
    throw new InvalidPdfAttachmentError(
      partIndex,
      part.fileName,
      `filename must contain 1-${String(PDF_MAXIMUM_FILENAME_CHARACTERS)} characters.`,
    );
  }
  if (part.mediaType !== PDF_MEDIA_TYPE) {
    throw new InvalidPdfAttachmentError(
      partIndex,
      part.fileName,
      `mediaType must be ${JSON.stringify(PDF_MEDIA_TYPE)}.`,
    );
  }
  if (!isSha256Hex(part.sourceSha256)) {
    throw new InvalidPdfAttachmentError(
      partIndex,
      part.fileName,
      "sourceSha256 must be a lowercase 64-character SHA-256 hex digest.",
    );
  }
  if (part.pages.length < 1 || part.pages.length > PDF_MAXIMUM_PAGE_COUNT) {
    throw new InvalidPdfAttachmentError(
      partIndex,
      part.fileName,
      `page count must be between 1 and ${String(PDF_MAXIMUM_PAGE_COUNT)}; received ${String(part.pages.length)}.`,
    );
  }

  let totalJpegBytes = 0;
  let totalTextCharacters = 0;
  part.pages.forEach((page, pageIndex): void => {
    const expectedPageNumber = pageIndex + 1;
    if (page.pageNumber !== expectedPageNumber) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `page ordering must be consecutive and 1-based; expected page ${String(expectedPageNumber)}, received ${String(page.pageNumber)}.`,
      );
    }
    if (page.text.length > PDF_MAXIMUM_PAGE_TEXT_CHARACTERS) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `page ${String(page.pageNumber)} extracted text exceeds ${String(PDF_MAXIMUM_PAGE_TEXT_CHARACTERS)} characters.`,
      );
    }
    totalTextCharacters += page.text.length;
    if (totalTextCharacters > PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `aggregate extracted text exceeds ${String(PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS)} characters.`,
      );
    }
    if (!hasValidBase64Shape(page.jpegBase64Data)) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `page ${String(page.pageNumber)} contains invalid JPEG base64 data.`,
      );
    }

    const pageJpegBytes = getBase64DecodedByteLength(page.jpegBase64Data);
    if (pageJpegBytes > PDF_MAXIMUM_PAGE_JPEG_BYTES) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `page ${String(page.pageNumber)} JPEG is ${String(pageJpegBytes)} bytes; maximum is ${String(PDF_MAXIMUM_PAGE_JPEG_BYTES)} bytes.`,
      );
    }
    totalJpegBytes += pageJpegBytes;
    if (totalJpegBytes > PDF_MAXIMUM_TOTAL_JPEG_BYTES) {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `aggregate JPEG data exceeds ${String(PDF_MAXIMUM_TOTAL_JPEG_BYTES)} bytes.`,
      );
    }

    const detectedMediaType = detectOpenAIImageMimeType(
      decodeBase64Prefix(page.jpegBase64Data),
    );
    if (detectedMediaType !== "image/jpeg") {
      throw new InvalidPdfAttachmentError(
        partIndex,
        part.fileName,
        `page ${String(page.pageNumber)} image does not have a JPEG signature.`,
      );
    }
  });
};

export const validateChatAttachments = (
  content: ReadonlyArray<ContentPart>,
): void => {
  content.forEach((part, partIndex): void => {
    if (part.type === "image") {
      validateImagePart(part, partIndex);
    } else if (part.type === "file") {
      validateFilePart(part, partIndex);
    } else if (part.type === "pdf") {
      validatePdfPart(part, partIndex);
    }
  });
};
