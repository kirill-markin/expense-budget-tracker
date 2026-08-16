import type {
  FileContentPart,
  PdfContentPart,
} from "@/server/chat/types";

export const PDF_MEDIA_TYPE = "application/pdf";
export const PDF_MAXIMUM_SOURCE_BYTES = 20 * 1024 * 1024;
export const PDF_MAXIMUM_PAGE_COUNT = 50;
export const PDF_MAXIMUM_PAGE_JPEG_BYTES = 750 * 1024;
export const PDF_MAXIMUM_TOTAL_JPEG_BYTES = 8 * 1024 * 1024;
export const PDF_MAXIMUM_PAGE_TEXT_CHARACTERS = 50_000;
export const PDF_MAXIMUM_TOTAL_TEXT_CHARACTERS = 500_000;
export const PDF_MAXIMUM_FILENAME_CHARACTERS = 255;
export const PDF_MAXIMUM_LONG_EDGE = 1600;
export const PDF_INITIAL_JPEG_QUALITY = 0.82;
export const PDF_MINIMUM_JPEG_QUALITY = 0.5;
export const PDF_MAXIMUM_ENCODE_ATTEMPTS = 6;

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_EXTENSION = ".pdf";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

const getBase64Sextet = (
  characterCode: number,
): number | null => {
  if (characterCode >= 0x41 && characterCode <= 0x5a) {
    return characterCode - 0x41;
  }
  if (characterCode >= 0x61 && characterCode <= 0x7a) {
    return characterCode - 0x61 + 26;
  }
  if (characterCode >= 0x30 && characterCode <= 0x39) {
    return characterCode - 0x30 + 52;
  }
  if (characterCode === 0x2b) {
    return 62;
  }
  if (characterCode === 0x2f) {
    return 63;
  }
  return null;
};

const decodeTolerantBase64Prefix = (
  value: string,
  maximumBytes: number,
): Uint8Array => {
  const bytes: Array<number> = [];
  let accumulator = 0;
  let accumulatedBits = 0;
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index);
    if (characterCode === 0x3d) {
      break;
    }
    const sextet = getBase64Sextet(characterCode);
    if (sextet === null) {
      continue;
    }

    accumulator = (accumulator << 6) | sextet;
    accumulatedBits += 6;
    if (accumulatedBits < 8) {
      continue;
    }

    accumulatedBits -= 8;
    bytes.push((accumulator >> accumulatedBits) & 0xff);
    if (bytes.length === maximumBytes) {
      break;
    }
    accumulator &= (1 << accumulatedBits) - 1;
  }
  return Uint8Array.from(bytes);
};

export const isPdfFileCandidate = (
  fileName: string,
  mediaType: string,
): boolean =>
  mediaType.trim().toLowerCase() === PDF_MEDIA_TYPE
  || fileName.trim().toLowerCase().endsWith(PDF_EXTENSION);

export const hasPdfSignature = (
  bytes: Uint8Array,
): boolean =>
  PDF_SIGNATURE.every((value, index) => bytes[index] === value);

export const isLegacyRawPdfFilePart = (
  part: FileContentPart,
): boolean =>
  isPdfFileCandidate(part.fileName, part.mediaType)
  || hasPdfSignature(
    decodeTolerantBase64Prefix(part.base64Data, PDF_SIGNATURE.length),
  );

export const isSha256Hex = (
  value: string,
): boolean => SHA256_HEX_PATTERN.test(value);

export const getBase64DecodedByteLength = (
  base64Data: string,
): number => {
  const paddingBytes = base64Data.endsWith("==")
    ? 2
    : base64Data.endsWith("=") ? 1 : 0;
  return Math.floor(base64Data.length * 3 / 4) - paddingBytes;
};

export const getPdfDerivedImageByteLength = (
  part: PdfContentPart,
): number =>
  part.pages.reduce(
    (total, page) => total + getBase64DecodedByteLength(page.jpegBase64Data),
    0,
  );

export const calculatePdfPageOutputBudget = (
  remainingOutputBytes: number,
  remainingPageCount: number,
): number => {
  if (!Number.isSafeInteger(remainingOutputBytes) || remainingOutputBytes <= 0) {
    throw new RangeError(
      `PDF remaining output bytes must be a positive safe integer; received ${String(remainingOutputBytes)}`,
    );
  }
  if (!Number.isSafeInteger(remainingPageCount) || remainingPageCount <= 0) {
    throw new RangeError(
      `PDF remaining page count must be a positive safe integer; received ${String(remainingPageCount)}`,
    );
  }

  return Math.min(
    PDF_MAXIMUM_PAGE_JPEG_BYTES,
    Math.floor(remainingOutputBytes / remainingPageCount),
  );
};
