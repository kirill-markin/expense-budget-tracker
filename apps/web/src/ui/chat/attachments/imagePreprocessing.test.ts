import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_IMAGE_PREPROCESSING_CONSTRAINTS,
  ImageDimensionsError,
  ImageFormatMismatchError,
  ImageSourceTooLargeError,
  UnsupportedImageFormatError,
  assertImageSourceSize,
  buildJpegFileName,
  calculateBoundedImageDimensions,
  calculateNextImageEncodeSettings,
  classifyImageFile,
  isImageOutputWithinLimit,
} from "./imagePreprocessing";

const HEIC_PREFIX = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]);
const JPEG_PREFIX = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_PREFIX = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("bounds landscape and portrait images proportionally", (): void => {
  assert.deepEqual(calculateBoundedImageDimensions(4032, 3024, 2048), {
    width: 2048,
    height: 1536,
  });
  assert.deepEqual(calculateBoundedImageDimensions(2000, 4000, 2048), {
    width: 1024,
    height: 2048,
  });
  assert.deepEqual(calculateBoundedImageDimensions(1200, 800, 2048), {
    width: 1200,
    height: 800,
  });
  assert.throws(
    (): void => { calculateBoundedImageDimensions(0, 800, 2048); },
    ImageDimensionsError,
  );
});

test("enforces source and output byte limits at their exact boundary", (): void => {
  assert.doesNotThrow((): void => { assertImageSourceSize("photo.heic", 100, 100); });
  assert.throws(
    (): void => { assertImageSourceSize("photo.heic", 101, 100); },
    ImageSourceTooLargeError,
  );
  assert.equal(isImageOutputWithinLimit(100, 100), true);
  assert.equal(isImageOutputWithinLimit(101, 100), false);
});

test("creates predictable JPEG filenames", (): void => {
  assert.equal(buildJpegFileName("holiday.photo.HEIC"), "holiday.photo.jpg");
  assert.equal(buildJpegFileName("scan.png"), "scan.jpg");
  assert.equal(buildJpegFileName("scan"), "scan.jpg");
  assert.equal(buildJpegFileName(""), "image.jpg");
});

test("classifies signature-backed HEIC and native images", (): void => {
  assert.deepEqual(classifyImageFile("photo.HEIC", "image/heic", HEIC_PREFIX), {
    decoder: "heic",
    detectedMediaType: "image/heic",
  });
  assert.deepEqual(classifyImageFile("upload", "image/jpg", JPEG_PREFIX), {
    decoder: "native",
    detectedMediaType: "image/jpeg",
  });
  assert.deepEqual(classifyImageFile("upload", "", PNG_PREFIX), {
    decoder: "native",
    detectedMediaType: "image/png",
  });
});

test("rejects contradictory or malformed image classifications", (): void => {
  assert.throws(
    (): void => { classifyImageFile("photo.heic", "image/heic", JPEG_PREFIX); },
    ImageFormatMismatchError,
  );
  assert.throws(
    (): void => { classifyImageFile("photo.jpg", "image/jpeg", HEIC_PREFIX); },
    ImageFormatMismatchError,
  );
  assert.throws(
    (): void => { classifyImageFile("photo.jpg", "", HEIC_PREFIX); },
    ImageFormatMismatchError,
  );
  assert.throws(
    (): void => { classifyImageFile("photo.png", "image/jpeg", PNG_PREFIX); },
    ImageFormatMismatchError,
  );
  assert.throws(
    (): void => { classifyImageFile("photo.jpg", "", PNG_PREFIX); },
    ImageFormatMismatchError,
  );
  assert.throws(
    (): void => { classifyImageFile("photo.bmp", "image/bmp", Uint8Array.from([0x42, 0x4d])); },
    UnsupportedImageFormatError,
  );
});

test("reduces dimensions and quality after an oversized JPEG attempt", (): void => {
  const next = calculateNextImageEncodeSettings(
    { width: 2048, height: 1536, quality: 0.85 },
    CHAT_IMAGE_PREPROCESSING_CONSTRAINTS.maximumOutputBytes * 2,
    CHAT_IMAGE_PREPROCESSING_CONSTRAINTS,
  );

  assert.deepEqual(next, { width: 1375, height: 1031, quality: 0.762 });
});
