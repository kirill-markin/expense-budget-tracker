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
import type { AttachmentPreparationError } from "./ChatComposer";
import type { PendingAttachment } from "./FileAttachment";

type MutableBooleanRef = { current: boolean };

export type ChatPendingSubmission = Readonly<{
  text: string;
  attachments: ReadonlyArray<PendingAttachment>;
}>;

export type ChatComposerContentOwner = "pending_submission" | "user";

export type ChatComposerMemoryState = Readonly<{
  pendingAttachments: ReadonlyArray<PendingAttachment>;
  attachmentErrors: ReadonlyArray<AttachmentPreparationError>;
  isAttachmentProcessing: boolean;
  pendingSubmission: ChatPendingSubmission | null;
  composerContentOwner: ChatComposerContentOwner;
}>;

export type ChatComposerMemoryUpdate =
  | ChatComposerMemoryState
  | ((currentState: ChatComposerMemoryState) => ChatComposerMemoryState);

export type ChatDraftUntouchedInput = Readonly<{
  text: string;
  pendingAttachmentCount: number;
  attachmentErrorCount: number;
  isAttachmentProcessing: boolean;
  hasPendingSubmission: boolean;
  messageCount: number;
}>;

const SUPPORTED_IMAGE_SIGNATURE_PREFIX_BYTES = 12;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createEmptyChatComposerMemory = (): ChatComposerMemoryState => ({
  pendingAttachments: [],
  attachmentErrors: [],
  isAttachmentProcessing: false,
  pendingSubmission: null,
  composerContentOwner: "user",
});

export const createChatPendingSubmission = (
  text: string,
  attachments: ReadonlyArray<PendingAttachment>,
): ChatPendingSubmission => ({
  text,
  attachments: [...attachments],
});

export const createTargetChatPendingSubmission = (
  memoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  targetKey: string,
  text: string,
): ChatPendingSubmission =>
  createChatPendingSubmission(
    text,
    readTargetChatComposerMemory(
      memoryByTarget,
      targetKey,
    ).pendingAttachments,
  );

export const restoreFailedChatSubmissionText = (
  currentText: string,
  pendingSubmission: ChatPendingSubmission,
  composerContentOwner: ChatComposerContentOwner,
): string =>
  composerContentOwner === "pending_submission"
    ? pendingSubmission.text
    : currentText;

export const markChatComposerContentEdited = (
  currentMemory: ChatComposerMemoryState,
): ChatComposerMemoryState =>
  currentMemory.composerContentOwner === "user"
    ? currentMemory
    : {
      ...currentMemory,
      composerContentOwner: "user",
    };

export const restoreFailedChatSubmissionMemory = (
  currentMemory: ChatComposerMemoryState,
): ChatComposerMemoryState => {
  const pendingSubmission = currentMemory.pendingSubmission;
  if (pendingSubmission === null) {
    return currentMemory;
  }

  return {
    ...currentMemory,
    pendingAttachments:
      currentMemory.composerContentOwner === "pending_submission"
        ? pendingSubmission.attachments
        : currentMemory.pendingAttachments,
    pendingSubmission: null,
    composerContentOwner: "user",
  };
};

export const revealUnresolvedChatSubmissionMemory = (
  currentMemory: ChatComposerMemoryState,
): ChatComposerMemoryState => {
  const pendingSubmission = currentMemory.pendingSubmission;
  if (pendingSubmission === null) {
    return currentMemory;
  }
  if (currentMemory.composerContentOwner === "user") {
    return currentMemory;
  }

  return {
    ...currentMemory,
    pendingAttachments: pendingSubmission.attachments,
  };
};

export const readTargetChatComposerMemory = (
  memoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  targetKey: string,
): ChatComposerMemoryState =>
  memoryByTarget.get(targetKey) ?? createEmptyChatComposerMemory();

export const updateTargetChatComposerMemory = (
  memoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  targetKey: string,
  update: ChatComposerMemoryUpdate,
): ReadonlyMap<string, ChatComposerMemoryState> => {
  const currentMemory = readTargetChatComposerMemory(memoryByTarget, targetKey);
  const requestedMemory = typeof update === "function"
    ? update(currentMemory)
    : update;
  const nextMemory: ChatComposerMemoryState =
    requestedMemory.pendingSubmission === null
      ? {
        ...requestedMemory,
        composerContentOwner: "user",
      }
      : requestedMemory.pendingSubmission !== currentMemory.pendingSubmission
        ? {
          ...requestedMemory,
          composerContentOwner: "pending_submission",
        }
        : requestedMemory;
  const nextMemoryByTarget = new Map(memoryByTarget);
  nextMemoryByTarget.set(targetKey, nextMemory);
  return nextMemoryByTarget;
};

export class ChatComposerMemoryTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatComposerMemoryTransitionError";
  }
}

export const rekeyTargetChatComposerMemory = (
  memoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  sourceTargetKey: string,
  destinationTargetKey: string,
): ReadonlyMap<string, ChatComposerMemoryState> => {
  const sourceMemory = memoryByTarget.get(sourceTargetKey);
  if (sourceMemory === undefined) {
    throw new ChatComposerMemoryTransitionError(
      `Cannot rekey chat composer memory from "${sourceTargetKey}" to `
      + `"${destinationTargetKey}": source target does not exist`,
    );
  }
  if (sourceTargetKey === destinationTargetKey) {
    throw new ChatComposerMemoryTransitionError(
      `Cannot rekey chat composer memory from "${sourceTargetKey}" to itself`,
    );
  }
  if (memoryByTarget.has(destinationTargetKey)) {
    throw new ChatComposerMemoryTransitionError(
      `Cannot rekey chat composer memory from "${sourceTargetKey}" to `
      + `"${destinationTargetKey}": destination target already exists`,
    );
  }

  const nextMemoryByTarget = new Map(memoryByTarget);
  nextMemoryByTarget.delete(sourceTargetKey);
  nextMemoryByTarget.set(destinationTargetKey, sourceMemory);
  return nextMemoryByTarget;
};

export const deleteTargetChatComposerMemory = (
  memoryByTarget: ReadonlyMap<string, ChatComposerMemoryState>,
  targetKey: string,
): ReadonlyMap<string, ChatComposerMemoryState> => {
  const nextMemoryByTarget = new Map(memoryByTarget);
  nextMemoryByTarget.delete(targetKey);
  return nextMemoryByTarget;
};

export const isChatDraftUntouched = (
  input: ChatDraftUntouchedInput,
): boolean =>
  input.text === ""
  && input.pendingAttachmentCount === 0
  && input.attachmentErrorCount === 0
  && !input.isAttachmentProcessing
  && !input.hasPendingSubmission
  && input.messageCount === 0;

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
