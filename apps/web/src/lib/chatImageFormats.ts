export const OPENAI_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type OpenAIImageMimeType = (typeof OPENAI_IMAGE_MIME_TYPES)[number];

export const OPENAI_IMAGE_FILE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;

export const HEIC_IMAGE_MIME_TYPES = [
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
] as const;

export type HeicImageMimeType = (typeof HEIC_IMAGE_MIME_TYPES)[number];

export const HEIC_FILE_EXTENSIONS = [".heic", ".heif"] as const;

export type HeicFileExtension = (typeof HEIC_FILE_EXTENSIONS)[number];

export const HEIC_FTYP_BRANDS = [
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
] as const;

export type HeicFtypBrand = (typeof HEIC_FTYP_BRANDS)[number];

export const MAX_HEIC_FTYP_BOX_BYTES = 4 * 1024;

const MINIMUM_FTYP_BOX_BYTES = 16;
const FTYP_COMPATIBLE_BRANDS_OFFSET = 16;
const FTYP_BRAND_BYTES = 4;

const hasString = (values: ReadonlyArray<string>, value: string): boolean =>
  values.includes(value);

const normalizedMimeType = (value: string): string =>
  value.trim().toLowerCase();

export const normalizeOpenAIImageMimeType = (
  value: string,
): OpenAIImageMimeType | null => {
  const normalized = normalizedMimeType(value);
  if (normalized === "image/jpg") {
    return "image/jpeg";
  }
  return hasString(OPENAI_IMAGE_MIME_TYPES, normalized)
    ? normalized as OpenAIImageMimeType
    : null;
};

export const normalizeHeicImageMimeType = (
  value: string,
): HeicImageMimeType | null => {
  const normalized = normalizedMimeType(value);
  return hasString(HEIC_IMAGE_MIME_TYPES, normalized)
    ? normalized as HeicImageMimeType
    : null;
};

export const getFileExtension = (fileName: string): string => {
  const lastPathSeparator = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > lastPathSeparator ? fileName.slice(lastDot).toLowerCase() : "";
};

export const isHeicFileExtension = (fileName: string): boolean =>
  hasString(HEIC_FILE_EXTENSIONS, getFileExtension(fileName));

export const detectOpenAIImageMimeTypeFromFileName = (
  fileName: string,
): OpenAIImageMimeType | null => {
  const extension = getFileExtension(fileName);
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return null;
};

const hasBytesAt = (
  bytes: Uint8Array,
  offset: number,
  expected: ReadonlyArray<number>,
): boolean => {
  if (bytes.byteLength < offset + expected.length) {
    return false;
  }
  return expected.every((value: number, index: number): boolean =>
    bytes[offset + index] === value);
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string => {
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
};

const readUint32BigEndian = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0)) >>> 0;

export const detectHeicFtypBrand = (bytes: Uint8Array): HeicFtypBrand | null => {
  if (bytes.byteLength < 12 || !hasBytesAt(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    return null;
  }

  const boxSize = readUint32BigEndian(bytes, 0);
  if (
    boxSize < MINIMUM_FTYP_BOX_BYTES
    || boxSize > MAX_HEIC_FTYP_BOX_BYTES
    || (boxSize - MINIMUM_FTYP_BOX_BYTES) % FTYP_BRAND_BYTES !== 0
  ) {
    return null;
  }

  const majorBrand = readAscii(bytes, 8, FTYP_BRAND_BYTES);
  if (hasString(HEIC_FTYP_BRANDS, majorBrand)) {
    return majorBrand as HeicFtypBrand;
  }
  if (bytes.byteLength < boxSize) {
    return null;
  }

  for (
    let offset = FTYP_COMPATIBLE_BRANDS_OFFSET;
    offset < boxSize;
    offset += FTYP_BRAND_BYTES
  ) {
    const compatibleBrand = readAscii(bytes, offset, FTYP_BRAND_BYTES);
    if (hasString(HEIC_FTYP_BRANDS, compatibleBrand)) {
      return compatibleBrand as HeicFtypBrand;
    }
  }
  return null;
};

export const hasHeicFileSignature = (bytes: Uint8Array): boolean =>
  detectHeicFtypBrand(bytes) !== null;

export const detectOpenAIImageMimeType = (
  bytes: Uint8Array,
): OpenAIImageMimeType | null => {
  if (hasBytesAt(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (hasBytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    hasBytesAt(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || hasBytesAt(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    hasBytesAt(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && hasBytesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  return null;
};
