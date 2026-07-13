import assert from "node:assert/strict";
import test from "node:test";
import {
  HEIC_FTYP_BRANDS,
  MAX_HEIC_FTYP_BOX_BYTES,
  detectHeicFtypBrand,
  detectOpenAIImageMimeTypeFromFileName,
  detectOpenAIImageMimeType,
  getFileExtension,
  isHeicFileExtension,
  normalizeHeicImageMimeType,
  normalizeOpenAIImageMimeType,
} from "./chatImageFormats";

const asciiBytes = (value: string): ReadonlyArray<number> =>
  Array.from(value, (character): number => character.charCodeAt(0));

const uint32BigEndianBytes = (value: number): ReadonlyArray<number> => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const createFtypBox = (
  majorBrand: string,
  compatibleBrands: ReadonlyArray<string>,
): Uint8Array => {
  const boxSize = 16 + (compatibleBrands.length * 4);
  return Uint8Array.from([
    ...uint32BigEndianBytes(boxSize),
    ...asciiBytes("ftyp"),
    ...asciiBytes(majorBrand),
    0x00, 0x00, 0x00, 0x00,
    ...compatibleBrands.flatMap(asciiBytes),
  ]);
};

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

test("recognizes HEIC and HEIF ftyp major and compatible brands", (): void => {
  for (const brand of HEIC_FTYP_BRANDS) {
    assert.equal(detectHeicFtypBrand(createFtypBox(brand, [])), brand);
    assert.equal(detectHeicFtypBrand(createFtypBox("isom", ["iso2", brand])), brand);
  }
});

test("checks compatible brands through the complete bounded ftyp box", (): void => {
  const compatibleBrandCount = (MAX_HEIC_FTYP_BOX_BYTES - 16) / 4;
  const compatibleBrands = Array.from(
    { length: compatibleBrandCount },
    (_value, index): string => index === compatibleBrandCount - 1 ? "heic" : "isom",
  );

  assert.equal(
    detectHeicFtypBrand(createFtypBox("isom", compatibleBrands)),
    "heic",
  );
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
    detectHeicFtypBrand(createFtypBox("avif", [])),
    null,
  );
  assert.equal(
    detectHeicFtypBrand(createFtypBox("isom", ["heic"]).slice(0, -4)),
    null,
  );
  assert.equal(
    detectHeicFtypBrand(Uint8Array.from([
      (MAX_HEIC_FTYP_BOX_BYTES + 4) >>> 24,
      ((MAX_HEIC_FTYP_BOX_BYTES + 4) >>> 16) & 0xff,
      ((MAX_HEIC_FTYP_BOX_BYTES + 4) >>> 8) & 0xff,
      (MAX_HEIC_FTYP_BOX_BYTES + 4) & 0xff,
      0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
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
