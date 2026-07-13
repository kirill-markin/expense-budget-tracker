"use client";

import {
  detectOpenAIImageMimeTypeFromFileName,
  detectOpenAIImageMimeType,
  hasHeicFileSignature,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  normalizeOpenAIImageMimeType,
  type OpenAIImageMimeType,
} from "@/lib/chatImageFormats";

const IMAGE_SIGNATURE_PREFIX_BYTES = 32;
const JPEG_MEDIA_TYPE = "image/jpeg";
const RESIZE_SAFETY_FACTOR = 0.95;
const MAX_RESIZE_STEP = 0.9;

export type ImagePreprocessingConstraints = Readonly<{
  maximumSourceBytes: number;
  maximumLongEdge: number;
  initialJpegQuality: number;
  minimumJpegQuality: number;
  maximumOutputBytes: number;
  maximumEncodeAttempts: number;
}>;

export const CHAT_IMAGE_PREPROCESSING_CONSTRAINTS: ImagePreprocessingConstraints = {
  maximumSourceBytes: 20 * 1024 * 1024,
  maximumLongEdge: 2048,
  initialJpegQuality: 0.85,
  minimumJpegQuality: 0.5,
  maximumOutputBytes: 2.5 * 1024 * 1024,
  maximumEncodeAttempts: 5,
};

export type PreparedImageAttachment = Readonly<{
  fileName: string;
  mediaType: "image/jpeg";
  base64Data: string;
}>;

export type ImageDimensions = Readonly<{
  width: number;
  height: number;
}>;

export type ImageEncodeSettings = ImageDimensions & Readonly<{
  quality: number;
}>;

export type ImageFileClassification = Readonly<{
  decoder: "heic" | "native";
  detectedMediaType: OpenAIImageMimeType | "image/heic";
}>;

export class ImagePreprocessingConfigurationError extends Error {
  public constructor(message: string) {
    super(`Invalid image preprocessing constraints: ${message}`);
    this.name = "ImagePreprocessingConfigurationError";
  }
}

export class ImageSourceTooLargeError extends Error {
  public constructor(fileName: string, sourceBytes: number, maximumSourceBytes: number) {
    super(
      `Image "${fileName}" is too large to process: ${sourceBytes} bytes exceeds the ${maximumSourceBytes}-byte source limit.`,
    );
    this.name = "ImageSourceTooLargeError";
  }
}

export class ImageReadError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to read image "${fileName}": ${reason}`);
    this.name = "ImageReadError";
  }
}

export class ImageFormatMismatchError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Image "${fileName}" has contradictory format metadata: ${reason}`);
    this.name = "ImageFormatMismatchError";
  }
}

export class UnsupportedImageFormatError extends Error {
  public constructor(fileName: string, mediaType: string) {
    const declaredType = mediaType.trim() === "" ? "no declared MIME type" : `declared MIME type ${mediaType}`;
    super(`Image "${fileName}" has an unsupported or malformed file signature (${declaredType}).`);
    this.name = "UnsupportedImageFormatError";
  }
}

export class ImageDimensionsError extends Error {
  public constructor(width: number, height: number) {
    super(`Image dimensions must be positive integers; received ${width}x${height}.`);
    this.name = "ImageDimensionsError";
  }
}

export class ImageDecodeError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to decode image "${fileName}": ${reason}`);
    this.name = "ImageDecodeError";
  }
}

export class ImageEncodeError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to encode image "${fileName}" as JPEG: ${reason}`);
    this.name = "ImageEncodeError";
  }
}

export class ImageOutputTooLargeError extends Error {
  public constructor(
    fileName: string,
    outputBytes: number,
    maximumOutputBytes: number,
    maximumEncodeAttempts: number,
  ) {
    super(
      `Image "${fileName}" is still ${outputBytes} bytes after ${maximumEncodeAttempts} JPEG encode attempts; maximum output is ${maximumOutputBytes} bytes.`,
    );
    this.name = "ImageOutputTooLargeError";
  }
}

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ImagePreprocessingConfigurationError(`${name} must be a positive integer; received ${value}`);
  }
};

export const validateImagePreprocessingConstraints = (
  constraints: ImagePreprocessingConstraints,
): void => {
  assertPositiveInteger("maximumSourceBytes", constraints.maximumSourceBytes);
  assertPositiveInteger("maximumLongEdge", constraints.maximumLongEdge);
  assertPositiveInteger("maximumOutputBytes", constraints.maximumOutputBytes);
  assertPositiveInteger("maximumEncodeAttempts", constraints.maximumEncodeAttempts);

  if (
    !Number.isFinite(constraints.initialJpegQuality)
    || constraints.initialJpegQuality <= 0
    || constraints.initialJpegQuality > 1
  ) {
    throw new ImagePreprocessingConfigurationError(
      `initialJpegQuality must be greater than 0 and at most 1; received ${constraints.initialJpegQuality}`,
    );
  }
  if (
    !Number.isFinite(constraints.minimumJpegQuality)
    || constraints.minimumJpegQuality <= 0
    || constraints.minimumJpegQuality > constraints.initialJpegQuality
  ) {
    throw new ImagePreprocessingConfigurationError(
      `minimumJpegQuality must be greater than 0 and at most initialJpegQuality; received ${constraints.minimumJpegQuality}`,
    );
  }
};

export const assertImageSourceSize = (
  fileName: string,
  sourceBytes: number,
  maximumSourceBytes: number,
): void => {
  if (sourceBytes > maximumSourceBytes) {
    throw new ImageSourceTooLargeError(fileName, sourceBytes, maximumSourceBytes);
  }
};

export const isImageOutputWithinLimit = (
  outputBytes: number,
  maximumOutputBytes: number,
): boolean => outputBytes <= maximumOutputBytes;

export const buildJpegFileName = (fileName: string): string => {
  const lastDot = fileName.lastIndexOf(".");
  const stem = lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
  return `${stem === "" ? "image" : stem}.jpg`;
};

export const calculateBoundedImageDimensions = (
  sourceWidth: number,
  sourceHeight: number,
  maximumLongEdge: number,
): ImageDimensions => {
  if (
    !Number.isInteger(sourceWidth)
    || sourceWidth <= 0
    || !Number.isInteger(sourceHeight)
    || sourceHeight <= 0
  ) {
    throw new ImageDimensionsError(sourceWidth, sourceHeight);
  }
  assertPositiveInteger("maximumLongEdge", maximumLongEdge);

  const longEdge = Math.max(sourceWidth, sourceHeight);
  if (longEdge <= maximumLongEdge) {
    return { width: sourceWidth, height: sourceHeight };
  }

  const scale = maximumLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
};

export const classifyImageFile = (
  fileName: string,
  declaredMediaType: string,
  prefix: Uint8Array,
): ImageFileClassification => {
  const declaredOpenAIType = normalizeOpenAIImageMimeType(declaredMediaType);
  const declaredOpenAIExtensionType = detectOpenAIImageMimeTypeFromFileName(fileName);
  const declaredHeicType = normalizeHeicImageMimeType(declaredMediaType);
  const hasDeclaredHeicType = declaredHeicType !== null;
  const hasDeclaredHeicExtension = isHeicFileExtension(fileName);
  const hasHeicSignature = hasHeicFileSignature(prefix);
  const hasOtherDeclaredImageType = declaredMediaType.trim().toLowerCase().startsWith("image/")
    && declaredOpenAIType === null
    && declaredHeicType === null;

  if (hasHeicSignature) {
    if (
      declaredOpenAIType !== null
      || declaredOpenAIExtensionType !== null
      || hasOtherDeclaredImageType
    ) {
      throw new ImageFormatMismatchError(
        fileName,
        "the declared MIME type or extension does not match the HEIC/HEIF ftyp signature",
      );
    }
    return { decoder: "heic", detectedMediaType: "image/heic" };
  }

  if (hasDeclaredHeicType || hasDeclaredHeicExtension) {
    throw new ImageFormatMismatchError(
      fileName,
      "the HEIC/HEIF MIME type or extension is not backed by a recognized ftyp signature",
    );
  }

  const detectedMediaType = detectOpenAIImageMimeType(prefix);
  if (detectedMediaType === null) {
    throw new UnsupportedImageFormatError(fileName, declaredMediaType);
  }
  if (declaredOpenAIType !== null && declaredOpenAIType !== detectedMediaType) {
    throw new ImageFormatMismatchError(
      fileName,
      `${declaredMediaType} does not match the detected ${detectedMediaType} signature`,
    );
  }
  if (
    declaredOpenAIExtensionType !== null
    && declaredOpenAIExtensionType !== detectedMediaType
  ) {
    throw new ImageFormatMismatchError(
      fileName,
      `the filename extension does not match the detected ${detectedMediaType} signature`,
    );
  }
  if (hasOtherDeclaredImageType) {
    throw new ImageFormatMismatchError(
      fileName,
      `${declaredMediaType} does not match the detected ${detectedMediaType} signature`,
    );
  }

  return { decoder: "native", detectedMediaType };
};

export const calculateNextImageEncodeSettings = (
  current: ImageEncodeSettings,
  outputBytes: number,
  constraints: ImagePreprocessingConstraints,
): ImageEncodeSettings => {
  const qualityStep = (constraints.initialJpegQuality - constraints.minimumJpegQuality)
    / Math.max(1, constraints.maximumEncodeAttempts - 1);
  const quality = Math.max(
    constraints.minimumJpegQuality,
    Number((current.quality - qualityStep).toFixed(3)),
  );
  const targetScale = Math.sqrt(constraints.maximumOutputBytes / outputBytes)
    * RESIZE_SAFETY_FACTOR;
  const scale = Math.min(MAX_RESIZE_STEP, targetScale);

  return {
    width: Math.max(1, Math.floor(current.width * scale)),
    height: Math.max(1, Math.floor(current.height * scale)),
    quality,
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const decodeNativeImage = async (file: File): Promise<ImageBitmap> => {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (error) {
    throw new ImageDecodeError(file.name, errorMessage(error));
  }
};

const decodeHeicImage = async (file: File): Promise<ImageBitmap> => {
  try {
    const { heicTo } = await import("heic-to/csp");
    return await heicTo({
      blob: file,
      type: "bitmap",
      options: { imageOrientation: "from-image" },
    });
  } catch (error) {
    throw new ImageDecodeError(file.name, errorMessage(error));
  }
};

const decodeImage = async (
  file: File,
  classification: ImageFileClassification,
): Promise<ImageBitmap> =>
  classification.decoder === "heic"
    ? decodeHeicImage(file)
    : decodeNativeImage(file);

const encodeCanvasAsJpeg = (
  canvas: HTMLCanvasElement,
  quality: number,
  fileName: string,
): Promise<Blob> =>
  new Promise<Blob>((resolve, reject): void => {
    try {
      canvas.toBlob((blob: Blob | null): void => {
        if (blob === null || blob.size === 0) {
          reject(new ImageEncodeError(fileName, "canvas.toBlob returned no data"));
          return;
        }
        if (blob.type !== JPEG_MEDIA_TYPE) {
          reject(new ImageEncodeError(fileName, `canvas.toBlob returned ${blob.type}`));
          return;
        }
        resolve(blob);
      }, JPEG_MEDIA_TYPE, quality);
    } catch (error) {
      reject(new ImageEncodeError(fileName, errorMessage(error)));
    }
  });

const releaseCanvas = (canvas: HTMLCanvasElement): void => {
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  context?.clearRect(0, 0, 1, 1);
};

const encodeBoundedJpeg = async (
  bitmap: ImageBitmap,
  fileName: string,
  constraints: ImagePreprocessingConstraints,
): Promise<Blob> => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) {
    releaseCanvas(canvas);
    throw new ImageEncodeError(fileName, "Canvas 2D context is unavailable");
  }

  const initialDimensions = calculateBoundedImageDimensions(
    bitmap.width,
    bitmap.height,
    constraints.maximumLongEdge,
  );
  let settings: ImageEncodeSettings = {
    ...initialDimensions,
    quality: constraints.initialJpegQuality,
  };
  let lastOutputBytes = 0;

  try {
    for (let attempt = 0; attempt < constraints.maximumEncodeAttempts; attempt += 1) {
      canvas.width = settings.width;
      canvas.height = settings.height;
      context.clearRect(0, 0, settings.width, settings.height);
      try {
        context.drawImage(bitmap, 0, 0, settings.width, settings.height);
      } catch (error) {
        throw new ImageEncodeError(fileName, errorMessage(error));
      }

      const output = await encodeCanvasAsJpeg(canvas, settings.quality, fileName);
      lastOutputBytes = output.size;
      if (isImageOutputWithinLimit(output.size, constraints.maximumOutputBytes)) {
        return output;
      }
      if (attempt + 1 < constraints.maximumEncodeAttempts) {
        settings = calculateNextImageEncodeSettings(settings, output.size, constraints);
      }
    }
  } finally {
    releaseCanvas(canvas);
  }

  throw new ImageOutputTooLargeError(
    fileName,
    lastOutputBytes,
    constraints.maximumOutputBytes,
    constraints.maximumEncodeAttempts,
  );
};

const blobToBase64 = (blob: Blob, fileName: string): Promise<string> =>
  new Promise<string>((resolve, reject): void => {
    const reader = new FileReader();
    reader.onload = (): void => {
      if (typeof reader.result !== "string") {
        reject(new ImageEncodeError(fileName, "FileReader returned a non-string result"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      if (commaIndex < 0) {
        reject(new ImageEncodeError(fileName, "FileReader returned an invalid data URL"));
        return;
      }
      resolve(reader.result.slice(commaIndex + 1));
    };
    reader.onerror = (): void => {
      reject(new ImageEncodeError(fileName, errorMessage(reader.error)));
    };
    try {
      reader.readAsDataURL(blob);
    } catch (error) {
      reject(new ImageEncodeError(fileName, errorMessage(error)));
    }
  });

const readImagePrefix = async (file: File): Promise<Uint8Array> => {
  try {
    return new Uint8Array(
      await file.slice(0, IMAGE_SIGNATURE_PREFIX_BYTES).arrayBuffer(),
    );
  } catch (error) {
    throw new ImageReadError(file.name, errorMessage(error));
  }
};

export const preprocessImageAttachment = async (
  file: File,
  constraints: ImagePreprocessingConstraints,
): Promise<PreparedImageAttachment> => {
  validateImagePreprocessingConstraints(constraints);
  assertImageSourceSize(file.name, file.size, constraints.maximumSourceBytes);

  const prefix = await readImagePrefix(file);
  const classification = classifyImageFile(file.name, file.type, prefix);
  let bitmap: ImageBitmap | null = null;

  try {
    bitmap = await decodeImage(file, classification);
    const output = await encodeBoundedJpeg(bitmap, file.name, constraints);
    const base64Data = await blobToBase64(output, file.name);
    return {
      fileName: buildJpegFileName(file.name),
      mediaType: JPEG_MEDIA_TYPE,
      base64Data,
    };
  } finally {
    bitmap?.close();
  }
};
