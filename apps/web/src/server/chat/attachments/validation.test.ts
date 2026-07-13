import assert from "node:assert/strict";
import test from "node:test";
import {
  HeicFileAttachmentError,
  ImageMimeSignatureMismatchError,
  InvalidBase64ImageDataError,
  UnsupportedImageMediaTypeError,
  validateChatAttachments,
} from "@/server/chat/attachments/validation";
import type {
  FileContentPart,
  ImageContentPart,
} from "@/server/chat/types";

const JPEG_BASE64_PREFIX = "/9j/4AAQSkZJRg==";
const PNG_BASE64_PREFIX = "iVBORw0KGgo=";
const GIF_BASE64_PREFIX = "R0lGODlhAQA=";
const WEBP_BASE64_PREFIX = "UklGRiQAAABXRUJQVlA4IA==";
const HEIC_BASE64_PREFIX = "AAAAGGZ0eXBoZWljAAAAAA==";
const HEIC_COMPATIBLE_BRAND_BASE64 = "AAAAFGZ0eXBpc29tAAAAAGhlaWM=";
const HEIC_UNPADDED_BASE64_PREFIX = HEIC_BASE64_PREFIX.slice(0, -2);
const HEIC_WHITESPACE_BASE64_PREFIX = "AAAA GGZ0eXBo\nZWljAAAAAA==";
const XLSX_BASE64_PREFIX = "UEsDBBQABgA=";

const createImagePart = (
  mediaType: string,
  base64Data: string,
): ImageContentPart => ({
  type: "image",
  mediaType,
  base64Data,
});

const createFilePart = (
  fileName: string,
  mediaType: string,
  base64Data: string,
): FileContentPart => ({
  type: "file",
  fileName,
  mediaType,
  base64Data,
});

test("validateChatAttachments accepts supported images with matching signatures", (): void => {
  const validImages: ReadonlyArray<ImageContentPart> = [
    createImagePart("image/jpeg", JPEG_BASE64_PREFIX),
    createImagePart("image/png", PNG_BASE64_PREFIX),
    createImagePart("image/gif", GIF_BASE64_PREFIX),
    createImagePart("image/webp", WEBP_BASE64_PREFIX),
  ];

  assert.doesNotThrow((): void => validateChatAttachments(validImages));
});

test("validateChatAttachments rejects raw HEIC image parts", (): void => {
  assert.throws(
    (): void => validateChatAttachments([
      { type: "text", text: "Inspect this image" },
      createImagePart("image/heic", HEIC_BASE64_PREFIX),
    ]),
    (error: unknown): boolean => {
      assert.ok(error instanceof UnsupportedImageMediaTypeError);
      assert.match(error.message, /Content part 1/);
      assert.match(error.message, /claimed MIME "image\/heic"/);
      assert.equal(error.message.includes(HEIC_BASE64_PREFIX), false);
      return true;
    },
  );
});

test("validateChatAttachments rejects a HEIC signature mislabeled as JPEG", (): void => {
  assert.throws(
    (): void => validateChatAttachments([
      createImagePart("image/jpeg", HEIC_BASE64_PREFIX),
    ]),
    (error: unknown): boolean => {
      assert.ok(error instanceof ImageMimeSignatureMismatchError);
      assert.match(error.message, /Content part 0/);
      assert.match(error.message, /image\/heic signature/);
      assert.match(error.message, /claimed MIME "image\/jpeg"/);
      assert.equal(error.message.includes(HEIC_BASE64_PREFIX), false);
      return true;
    },
  );
});

test("validateChatAttachments rejects supported MIME types with another image signature", (): void => {
  assert.throws(
    (): void => validateChatAttachments([
      createImagePart("image/jpeg", PNG_BASE64_PREFIX),
    ]),
    ImageMimeSignatureMismatchError,
  );
});

test("validateChatAttachments rejects malformed base64 image data", (): void => {
  const malformedBase64 = "%%%not-base64%%%";

  assert.throws(
    (): void => validateChatAttachments([
      createImagePart("image/png", malformedBase64),
    ]),
    (error: unknown): boolean => {
      assert.ok(error instanceof InvalidBase64ImageDataError);
      assert.match(error.message, /Content part 0/);
      assert.match(error.message, /claimed MIME "image\/png"/);
      assert.equal(error.message.includes(malformedBase64), false);
      return true;
    },
  );
});

test("validateChatAttachments rejects HEIC file extensions with empty or generic MIME types", (): void => {
  const disguisedFiles: ReadonlyArray<FileContentPart> = [
    createFilePart("camera.HEIC", "", HEIC_BASE64_PREFIX),
    createFilePart("camera.HEIC", "application/octet-stream", HEIC_BASE64_PREFIX),
  ];

  for (const file of disguisedFiles) {
    assert.throws(
      (): void => validateChatAttachments([file]),
      (error: unknown): boolean => {
        assert.ok(error instanceof HeicFileAttachmentError);
        assert.match(error.message, /Content part 0/);
        assert.match(error.message, new RegExp(`filename ${JSON.stringify(file.fileName)}`));
        assert.match(error.message, new RegExp(`claimed MIME ${JSON.stringify(file.mediaType)}`));
        assert.equal(error.message.includes(file.base64Data), false);
        return true;
      },
    );
  }
});

test("validateChatAttachments rejects HEIC generic files by MIME and signature", (): void => {
  const disguisedFiles: ReadonlyArray<FileContentPart> = [
    createFilePart("camera.bin", "image/heif", XLSX_BASE64_PREFIX),
    createFilePart("camera.bin", "application/octet-stream", HEIC_BASE64_PREFIX),
    createFilePart("camera.bin", "application/octet-stream", HEIC_COMPATIBLE_BRAND_BASE64),
  ];

  for (const file of disguisedFiles) {
    assert.throws(
      (): void => validateChatAttachments([file]),
      HeicFileAttachmentError,
    );
  }
});

test("validateChatAttachments rejects unpadded and whitespace-encoded HEIC generic files", (): void => {
  const disguisedFiles: ReadonlyArray<FileContentPart> = [
    createFilePart("camera.bin", "application/octet-stream", HEIC_UNPADDED_BASE64_PREFIX),
    createFilePart("camera.bin", "application/octet-stream", HEIC_WHITESPACE_BASE64_PREFIX),
  ];

  for (const file of disguisedFiles) {
    assert.throws(
      (): void => validateChatAttachments([file]),
      HeicFileAttachmentError,
    );
  }
});

test("validateChatAttachments leaves XLSX attachments unchanged", (): void => {
  const workbook = createFilePart(
    "budget.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    XLSX_BASE64_PREFIX,
  );

  assert.doesNotThrow((): void => validateChatAttachments([workbook]));
});

test("validateChatAttachments accepts valid large image and generic file base64", (): void => {
  const largeJpegBase64 = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(4 * 1024 * 1024),
  ]).toString("base64");
  const largePdf = createFilePart(
    "report.pdf",
    "application/pdf",
    "A".repeat(5 * 1024 * 1024),
  );

  assert.doesNotThrow((): void => validateChatAttachments([
    createImagePart("image/jpeg", largeJpegBase64),
    largePdf,
  ]));
});
