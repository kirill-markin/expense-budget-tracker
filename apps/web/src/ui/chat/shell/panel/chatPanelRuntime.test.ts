import assert from "node:assert/strict";
import test from "node:test";

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
import {
  AttachmentReadError,
  ChatComposerMemoryTransitionError,
  createEmptyChatComposerMemory,
  deleteTargetChatComposerMemory,
  getAttachmentFailureReasonKey,
  hasSupportedImageAttachmentSignature,
  isChatDraftUntouched,
  markChatComposerContentEdited,
  readTargetChatComposerMemory,
  rekeyTargetChatComposerMemory,
  revealUnresolvedChatSubmissionMemory,
  restoreFailedChatSubmissionMemory,
  restoreFailedChatSubmissionText,
  startMountedLifecycle,
  updateTargetChatComposerMemory,
  type AttachmentFailureReasonKey,
  type ChatComposerMemoryState,
} from "./chatPanelRuntime";
import { resolveNewChatDraftTarget } from "../../workspace/chatWorkspaceState";

const HEIC_PREFIX: ReadonlyArray<number> = [
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63,
];
const JPEG_PREFIX: ReadonlyArray<number> = [0xff, 0xd8, 0xff];
const PNG_PREFIX: ReadonlyArray<number> = [
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
];

test("restores mounted state after a Strict Mode setup-cleanup-setup cycle", (): void => {
  const mountedRef = { current: false };

  const firstCleanup = startMountedLifecycle(mountedRef);
  assert.equal(mountedRef.current, true);
  firstCleanup();
  assert.equal(mountedRef.current, false);

  const secondCleanup = startMountedLifecycle(mountedRef);
  assert.equal(mountedRef.current, true);
  secondCleanup();
  assert.equal(mountedRef.current, false);
});

test("detects metadata-free supported images from bounded signature prefixes", async (): Promise<void> => {
  const imageFiles: ReadonlyArray<File> = [HEIC_PREFIX, JPEG_PREFIX, PNG_PREFIX]
    .map((prefix: ReadonlyArray<number>): File => new File(
      [new Uint8Array(prefix).buffer],
      "",
      { type: "application/octet-stream" },
    ));
  const documentFile = new File(
    [Uint8Array.from([0x25, 0x50, 0x44, 0x46])],
    "report",
    { type: "application/octet-stream" },
  );

  for (const imageFile of imageFiles) {
    assert.equal(await hasSupportedImageAttachmentSignature(imageFile), true);
  }
  assert.equal(await hasSupportedImageAttachmentSignature(documentFile), false);
});

test("maps attachment failures to localized reason keys", (): void => {
  const cases: ReadonlyArray<Readonly<{
    error: unknown;
    expected: AttachmentFailureReasonKey;
  }>> = [
    {
      error: new RangeError("document too large"),
      expected: "chat.attachmentFailureSourceTooLarge",
    },
    {
      error: new ImageSourceTooLargeError("photo.heic", 2, 1),
      expected: "chat.attachmentFailureSourceTooLarge",
    },
    {
      error: new ImageReadError("photo.heic", "read failed"),
      expected: "chat.attachmentFailureRead",
    },
    {
      error: new AttachmentReadError("report.pdf", "read failed"),
      expected: "chat.attachmentFailureRead",
    },
    {
      error: new ImageFormatMismatchError("photo.heic", "format mismatch"),
      expected: "chat.attachmentFailureInvalidFormat",
    },
    {
      error: new UnsupportedImageFormatError("photo.bmp", "image/bmp"),
      expected: "chat.attachmentFailureInvalidFormat",
    },
    {
      error: new ImageDecodeError("photo.heic", "decode failed"),
      expected: "chat.attachmentFailureDecode",
    },
    {
      error: new ImageOutputTooLargeError("photo.heic", 2, 1, 5),
      expected: "chat.attachmentFailureOutputTooLarge",
    },
    {
      error: new ImageEncodeError("photo.heic", "encode failed"),
      expected: "chat.attachmentFailureConversion",
    },
    {
      error: new ImageDimensionsError(0, 0),
      expected: "chat.attachmentFailureConversion",
    },
    {
      error: new ImagePreprocessingConfigurationError("invalid constraints"),
      expected: "chat.attachmentFailureConversion",
    },
    {
      error: new Error("unexpected technical detail"),
      expected: "chat.attachmentFailureConversion",
    },
  ];

  for (const entry of cases) {
    assert.equal(getAttachmentFailureReasonKey(entry.error), entry.expected);
  }
});

test("attachment and composer memory remains isolated by selected target", (): void => {
  const initialMemory = new Map<string, ChatComposerMemoryState>();
  const firstTargetMemory = updateTargetChatComposerMemory(
    initialMemory,
    "session:session-a",
    (currentMemory) => ({
      ...currentMemory,
      pendingAttachments: [{
        fileName: "receipt.jpg",
        mediaType: "image/jpeg",
        base64Data: "data",
      }],
      attachmentErrors: [{
        fileName: "broken.heic",
        message: "Could not prepare attachment",
      }],
    }),
  );

  assert.equal(
    readTargetChatComposerMemory(
      firstTargetMemory,
      "session:session-a",
    ).pendingAttachments.length,
    1,
  );
  assert.deepEqual(
    readTargetChatComposerMemory(
      firstTargetMemory,
      "session:session-b",
    ),
    {
      pendingAttachments: [],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
});

test("draft adoption rekeys all in-memory composer state", (): void => {
  const draftMemory = updateTargetChatComposerMemory(
    new Map<string, ChatComposerMemoryState>(),
    "draft:draft-1",
    {
      pendingAttachments: [{
        fileName: "receipt.jpg",
        mediaType: "image/jpeg",
        base64Data: "encoded-image",
      }],
      attachmentErrors: [{
        fileName: "broken.heic",
        message: "Could not prepare attachment",
      }],
      isAttachmentProcessing: true,
      pendingSubmission: {
        text: "first message",
        attachments: [],
      },
      composerContentOwner: "pending_submission",
    },
  );

  const adoptedMemory = rekeyTargetChatComposerMemory(
    draftMemory,
    "draft:draft-1",
    "session:session-1",
  );

  assert.equal(adoptedMemory.has("draft:draft-1"), false);
  assert.deepEqual(
    readTargetChatComposerMemory(adoptedMemory, "session:session-1"),
    {
      pendingAttachments: [{
        fileName: "receipt.jpg",
        mediaType: "image/jpeg",
        base64Data: "encoded-image",
      }],
      attachmentErrors: [{
        fileName: "broken.heic",
        message: "Could not prepare attachment",
      }],
      isAttachmentProcessing: true,
      pendingSubmission: {
        text: "first message",
        attachments: [],
      },
      composerContentOwner: "pending_submission",
    },
  );
});

test("draft adoption rejects invalid and destructive rekey transitions", (): void => {
  const sourceMemory = updateTargetChatComposerMemory(
    new Map<string, ChatComposerMemoryState>(),
    "draft:draft-1",
    createEmptyChatComposerMemory(),
  );

  assert.throws(
    () => rekeyTargetChatComposerMemory(
      sourceMemory,
      "draft:missing",
      "session:session-1",
    ),
    (error: unknown): boolean =>
      error instanceof ChatComposerMemoryTransitionError
      && /source target does not exist/u.test(error.message),
  );
  assert.throws(
    () => rekeyTargetChatComposerMemory(
      sourceMemory,
      "draft:draft-1",
      "draft:draft-1",
    ),
    (error: unknown): boolean =>
      error instanceof ChatComposerMemoryTransitionError
      && /to itself/u.test(error.message),
  );

  const occupiedMemory = updateTargetChatComposerMemory(
    sourceMemory,
    "session:session-1",
    createEmptyChatComposerMemory(),
  );
  assert.throws(
    () => rekeyTargetChatComposerMemory(
      occupiedMemory,
      "draft:draft-1",
      "session:session-1",
    ),
    (error: unknown): boolean =>
      error instanceof ChatComposerMemoryTransitionError
      && /destination target already exists/u.test(error.message),
  );
  assert.equal(occupiedMemory.has("draft:draft-1"), true);
  assert.equal(occupiedMemory.has("session:session-1"), true);
});

test("repeated draft adoption preserves the adopted destination", (): void => {
  const sourceMemory = updateTargetChatComposerMemory(
    new Map<string, ChatComposerMemoryState>(),
    "draft:draft-1",
    {
      ...createEmptyChatComposerMemory(),
      pendingAttachments: [{
        fileName: "receipt.txt",
        mediaType: "text/plain",
        base64Data: "receipt-data",
      }],
    },
  );
  const adoptedMemory = rekeyTargetChatComposerMemory(
    sourceMemory,
    "draft:draft-1",
    "session:session-1",
  );

  assert.throws(
    () => rekeyTargetChatComposerMemory(
      adoptedMemory,
      "draft:draft-1",
      "session:session-1",
    ),
    (error: unknown): boolean =>
      error instanceof ChatComposerMemoryTransitionError
      && /source target does not exist/u.test(error.message),
  );
  assert.deepEqual(
    adoptedMemory.get("session:session-1"),
    sourceMemory.get("draft:draft-1"),
  );
});

test("discarding a draft removes retained attachment state", (): void => {
  const draftMemory = updateTargetChatComposerMemory(
    new Map<string, ChatComposerMemoryState>(),
    "draft:draft-1",
    (memory) => ({
      ...memory,
      pendingAttachments: [{
        fileName: "large-receipt.jpg",
        mediaType: "image/jpeg",
        base64Data: "large-encoded-image",
      }],
    }),
  );

  const discardedMemory = deleteTargetChatComposerMemory(
    draftMemory,
    "draft:draft-1",
  );

  assert.equal(discardedMemory.has("draft:draft-1"), false);
  assert.deepEqual(
    readTargetChatComposerMemory(discardedMemory, "draft:draft-1"),
    {
      pendingAttachments: [],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
});

test("failed first-send state survives switching away from and back to its draft", (): void => {
  const failedAttachment = {
    fileName: "receipt.jpg",
    mediaType: "image/jpeg",
    base64Data: "in-memory-image-bytes",
  } as const;
  const pendingDraftMemory = updateTargetChatComposerMemory(
    new Map<string, ChatComposerMemoryState>(),
    "draft:draft-failed",
    {
      pendingAttachments: [],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: {
        text: "remember this expense",
        attachments: [failedAttachment],
      },
      composerContentOwner: "pending_submission",
    },
  );

  assert.deepEqual(
    readTargetChatComposerMemory(
      pendingDraftMemory,
      "session:session-other",
    ),
    {
      pendingAttachments: [],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
  const restoredDraftMemory = updateTargetChatComposerMemory(
    pendingDraftMemory,
    "draft:draft-failed",
    restoreFailedChatSubmissionMemory,
  );

  assert.equal(
    restoreFailedChatSubmissionText(
      "",
      {
        text: "remember this expense",
        attachments: [failedAttachment],
      },
      "pending_submission",
    ),
    "remember this expense",
  );
  assert.deepEqual(
    readTargetChatComposerMemory(
      restoredDraftMemory,
      "draft:draft-failed",
    ),
    {
      pendingAttachments: [failedAttachment],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
});

test("failed first-send recovery never overwrites follow-up composer edits", (): void => {
  const originalAttachment = {
    fileName: "original.jpg",
    mediaType: "image/jpeg",
    base64Data: "original-image-bytes",
  } as const;
  const followUpAttachment = {
    fileName: "follow-up.txt",
    mediaType: "text/plain",
    base64Data: "follow-up-bytes",
  } as const;
  const pendingSubmission = {
    text: "original prompt",
    attachments: [originalAttachment],
  } as const;
  const memoryWithFollowUp = {
    pendingAttachments: [followUpAttachment],
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "user",
  } as const;

  assert.equal(
    restoreFailedChatSubmissionText(
      "follow-up prompt",
      pendingSubmission,
      memoryWithFollowUp.composerContentOwner,
    ),
    "follow-up prompt",
  );
  assert.deepEqual(
    restoreFailedChatSubmissionMemory(memoryWithFollowUp),
    {
      pendingAttachments: [followUpAttachment],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
});

test("an unresolved first send remains visible but cannot lose ownership", (): void => {
  const pendingSubmission = {
    text: "uncertain prompt",
    attachments: [{
      fileName: "receipt.txt",
      mediaType: "text/plain",
      base64Data: "receipt-bytes",
    }],
  } as const;
  const unresolvedMemory = revealUnresolvedChatSubmissionMemory({
    pendingAttachments: [],
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "pending_submission",
  });

  assert.deepEqual(unresolvedMemory, {
    pendingAttachments: pendingSubmission.attachments,
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "pending_submission",
  });
  assert.equal(
    restoreFailedChatSubmissionText(
      "",
      pendingSubmission,
      unresolvedMemory.composerContentOwner,
    ),
    "uncertain prompt",
  );
});

test("clearing revealed submission content remains an explicit user edit", (): void => {
  const pendingSubmission = {
    text: "uncertain prompt",
    attachments: [{
      fileName: "receipt.txt",
      mediaType: "text/plain",
      base64Data: "receipt-bytes",
    }],
  } as const;
  const revealedMemory = revealUnresolvedChatSubmissionMemory({
    pendingAttachments: [],
    attachmentErrors: [],
    isAttachmentProcessing: false,
    pendingSubmission,
    composerContentOwner: "pending_submission",
  });
  const clearedMemory = markChatComposerContentEdited({
    ...revealedMemory,
    pendingAttachments: [],
  });

  assert.equal(
    restoreFailedChatSubmissionText(
      "",
      pendingSubmission,
      clearedMemory.composerContentOwner,
    ),
    "",
  );
  assert.deepEqual(
    restoreFailedChatSubmissionMemory(clearedMemory),
    {
      pendingAttachments: [],
      attachmentErrors: [],
      isAttachmentProcessing: false,
      pendingSubmission: null,
      composerContentOwner: "user",
    },
  );
});

test("New creates another draft after a failed first send leaves transcript errors", (): void => {
  const isUntouched = isChatDraftUntouched({
    text: "",
    pendingAttachmentCount: 0,
    attachmentErrorCount: 0,
    isAttachmentProcessing: false,
    hasPendingSubmission: false,
    messageCount: 2,
  });
  const nextTarget = resolveNewChatDraftTarget(
    { kind: "draft", draftId: "draft-failed" },
    "draft-failed",
    isUntouched,
    "draft-next",
  );

  assert.equal(isUntouched, false);
  assert.deepEqual(nextTarget, {
    kind: "draft",
    draftId: "draft-next",
  });
});

test("New does not treat a pending first send as an untouched draft", (): void => {
  assert.equal(isChatDraftUntouched({
    text: "",
    pendingAttachmentCount: 0,
    attachmentErrorCount: 0,
    isAttachmentProcessing: false,
    hasPendingSubmission: true,
    messageCount: 0,
  }), false);
});
