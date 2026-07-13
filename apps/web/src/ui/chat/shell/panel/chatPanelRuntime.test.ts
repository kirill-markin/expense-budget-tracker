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
  getAttachmentFailureReasonKey,
  hasSupportedImageAttachmentSignature,
  startMountedLifecycle,
  type AttachmentFailureReasonKey,
} from "./chatPanelRuntime";

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
