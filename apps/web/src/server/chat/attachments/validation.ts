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
import type {
  ContentPart,
  FileContentPart,
  ImageContentPart,
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

export const validateChatAttachments = (
  content: ReadonlyArray<ContentPart>,
): void => {
  content.forEach((part, partIndex): void => {
    if (part.type === "image") {
      validateImagePart(part, partIndex);
    } else if (part.type === "file") {
      validateFilePart(part, partIndex);
    }
  });
};
