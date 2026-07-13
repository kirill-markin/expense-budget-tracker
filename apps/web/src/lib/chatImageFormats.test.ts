import assert from "node:assert/strict";
import test from "node:test";
import {
  detectHeicFtypBrand,
  detectOpenAIImageMimeTypeFromFileName,
  detectOpenAIImageMimeType,
  getFileExtension,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  normalizeOpenAIImageMimeType,
} from "./chatImageFormats";

const HEIC_PREFIXES: ReadonlyArray<Readonly<{
  brand: "heic" | "heix" | "hevc" | "hevx" | "mif1" | "msf1";
  bytes: ReadonlyArray<number>;
}>> = [
  { brand: "heic", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00] },
  { brand: "heix", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x78, 0x00, 0x00, 0x00, 0x00] },
  { brand: "hevc", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x76, 0x63, 0x00, 0x00, 0x00, 0x00] },
  { brand: "hevx", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x76, 0x78, 0x00, 0x00, 0x00, 0x00] },
  { brand: "mif1", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00] },
  { brand: "msf1", bytes: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x73, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00] },
];

test("normalizes supported image MIME aliases", (): void => {
  assert.equal(normalizeOpenAIImageMimeType(" IMAGE/JPG "), "image/jpeg");
  assert.equal(normalizeOpenAIImageMimeType("image/jpeg"), "image/jpeg");
  assert.equal(normalizeOpenAIImageMimeType("image/png"), "image/png");
  assert.equal(normalizeOpenAIImageMimeType("image/heic"), null);
});

test("normalizes HEIC and HEIF sequence MIME types", (): void => {
  assert.equal(normalizeHeicImageMimeType("IMAGE/HEIC"), "image/heic");
  assert.equal(normalizeHeicImageMimeType("image/heif"), "image/heif");
  assert.equal(normalizeHeicImageMimeType("image/heic-sequence"), "image/heic-sequence");
  assert.equal(normalizeHeicImageMimeType("image/heif-sequence"), "image/heif-sequence");
  assert.equal(normalizeHeicImageMimeType("image/jpeg"), null);
});

test("recognizes HEIC and HEIF extensions case-insensitively", (): void => {
  assert.equal(getFileExtension("photo.HEIC"), ".heic");
  assert.equal(isHeicFileExtension("photo.HEIC"), true);
  assert.equal(isHeicFileExtension("photo.heif"), true);
  assert.equal(isHeicFileExtension("photo.jpg"), false);
  assert.equal(detectOpenAIImageMimeTypeFromFileName("photo.JPG"), "image/jpeg");
  assert.equal(detectOpenAIImageMimeTypeFromFileName("photo.webp"), "image/webp");
  assert.equal(detectOpenAIImageMimeTypeFromFileName("photo.heic"), null);
});

test("recognizes common HEIC and HEIF ftyp major brands", (): void => {
  for (const prefix of HEIC_PREFIXES) {
    assert.equal(detectHeicFtypBrand(Uint8Array.from(prefix.bytes)), prefix.brand);
  }
});

test("rejects malformed and unrelated ISO-BMFF prefixes", (): void => {
  assert.equal(detectHeicFtypBrand(Uint8Array.from([0x00, 0x00, 0x00, 0x18])), null);
  assert.equal(
    detectHeicFtypBrand(Uint8Array.from([
      0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ])),
    null,
  );
  assert.equal(
    detectHeicFtypBrand(Uint8Array.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
      0x00, 0x00, 0x00, 0x00,
    ])),
    null,
  );
});

test("detects supported OpenAI image formats from real magic-byte prefixes", (): void => {
  const fixtures: ReadonlyArray<Readonly<{
    expected: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    bytes: ReadonlyArray<number>;
  }>> = [
    { expected: "image/jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46] },
    { expected: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { expected: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00] },
    { expected: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00] },
    { expected: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20] },
  ];

  for (const fixture of fixtures) {
    assert.equal(detectOpenAIImageMimeType(Uint8Array.from(fixture.bytes)), fixture.expected);
  }
  assert.equal(detectOpenAIImageMimeType(Uint8Array.from([0x42, 0x4d, 0x00, 0x00])), null);
});
