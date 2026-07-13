import {
  detectOpenAIImageMimeType,
  hasHeicFileSignature,
} from "@/lib/chatImageFormats";
import {
  ImageDecodeError,
  ImageDimensionsError,
  ImageEncodeError,
  ImageFormatMismatchError,
  ImageOutputTooLargeError,
  ImagePreprocessingConfigurationError,
  ImageReadError,
  ImageSourceTooLargeError,
  UnsupportedImageFormatError,
} from "../../attachments/imagePreprocessing";

type MutableBooleanRef = { current: boolean };

const SUPPORTED_IMAGE_SIGNATURE_PREFIX_BYTES = 12;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class AttachmentReadError extends Error {
  public constructor(fileName: string, reason: string) {
    super(`Failed to read attachment "${fileName}": ${reason}`);
    this.name = "AttachmentReadError";
  }
}

export type AttachmentFailureReasonKey =
  | "chat.attachmentFailureSourceTooLarge"
  | "chat.attachmentFailureRead"
  | "chat.attachmentFailureInvalidFormat"
  | "chat.attachmentFailureDecode"
  | "chat.attachmentFailureOutputTooLarge"
  | "chat.attachmentFailureConversion";

export const startMountedLifecycle = (
  isMountedRef: MutableBooleanRef,
): (() => void) => {
  isMountedRef.current = true;

  return (): void => {
    isMountedRef.current = false;
  };
};

export const hasSupportedImageAttachmentSignature = async (
  file: File,
): Promise<boolean> => {
  try {
    const prefix = new Uint8Array(
      await file.slice(0, SUPPORTED_IMAGE_SIGNATURE_PREFIX_BYTES).arrayBuffer(),
    );
    return hasHeicFileSignature(prefix)
      || detectOpenAIImageMimeType(prefix) !== null;
  } catch (error) {
    throw new AttachmentReadError(file.name, errorMessage(error));
  }
};

export const getAttachmentFailureReasonKey = (
  error: unknown,
): AttachmentFailureReasonKey => {
  if (error instanceof RangeError || error instanceof ImageSourceTooLargeError) {
    return "chat.attachmentFailureSourceTooLarge";
  }
  if (error instanceof AttachmentReadError || error instanceof ImageReadError) {
    return "chat.attachmentFailureRead";
  }
  if (
    error instanceof ImageFormatMismatchError
    || error instanceof UnsupportedImageFormatError
  ) {
    return "chat.attachmentFailureInvalidFormat";
  }
  if (error instanceof ImageDecodeError) {
    return "chat.attachmentFailureDecode";
  }
  if (error instanceof ImageOutputTooLargeError) {
    return "chat.attachmentFailureOutputTooLarge";
  }
  if (
    error instanceof ImageEncodeError
    || error instanceof ImageDimensionsError
    || error instanceof ImagePreprocessingConfigurationError
  ) {
    return "chat.attachmentFailureConversion";
  }

  return "chat.attachmentFailureConversion";
};
