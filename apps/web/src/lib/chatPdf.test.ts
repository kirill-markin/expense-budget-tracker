import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_MAXIMUM_PAGE_JPEG_BYTES,
  PDF_MAXIMUM_TOTAL_JPEG_BYTES,
  PDF_SIGNATURE_SCAN_PREFIX_BYTES,
  calculatePdfPageOutputBudget,
  getBase64DecodedByteLength,
  getPdfDerivedImageByteLength,
  hasPdfSignature,
  isLegacyRawPdfFilePart,
  isPdfFileCandidate,
  isSha256Hex,
} from "@/lib/chatPdf";

test("PDF candidate and signature detection require declared PDF identity and real bytes", (): void => {
  assert.equal(isPdfFileCandidate("statement.PDF", "application/octet-stream"), true);
  assert.equal(isPdfFileCandidate("statement.bin", "application/pdf"), true);
  assert.equal(isPdfFileCandidate("statement.bin", "application/octet-stream"), false);
  assert.equal(hasPdfSignature(new TextEncoder().encode("%PDF-1.7")), true);
  assert.equal(hasPdfSignature(new TextEncoder().encode("leading bytes\n%PDF-1.7")), true);
  assert.equal(hasPdfSignature(new TextEncoder().encode("not a PDF")), false);
  const signature = new TextEncoder().encode("%PDF-");
  const signatureAtBoundary = new Uint8Array(PDF_SIGNATURE_SCAN_PREFIX_BYTES);
  signatureAtBoundary.set(
    signature,
    PDF_SIGNATURE_SCAN_PREFIX_BYTES - signature.length,
  );
  assert.equal(hasPdfSignature(signatureAtBoundary), true);
  const signatureOutsidePrefix = new Uint8Array(
    PDF_SIGNATURE_SCAN_PREFIX_BYTES + signature.length,
  );
  signatureOutsidePrefix.set(signature, PDF_SIGNATURE_SCAN_PREFIX_BYTES);
  assert.equal(hasPdfSignature(signatureOutsidePrefix), false);
});

test("legacy raw PDF detection shares MIME, extension, and signature recognition", (): void => {
  assert.equal(isLegacyRawPdfFilePart({
    type: "file",
    fileName: "statement.bin",
    mediaType: "application/pdf",
    base64Data: Buffer.from("opaque").toString("base64"),
  }), true);
  assert.equal(isLegacyRawPdfFilePart({
    type: "file",
    fileName: "statement.PDF",
    mediaType: "application/octet-stream",
    base64Data: Buffer.from("opaque").toString("base64"),
  }), true);
  assert.equal(isLegacyRawPdfFilePart({
    type: "file",
    fileName: "statement.bin",
    mediaType: "application/octet-stream",
    base64Data: "JVBE\nRi0xLjc=",
  }), true);
  assert.equal(isLegacyRawPdfFilePart({
    type: "file",
    fileName: "statement.txt",
    mediaType: "text/plain",
    base64Data: Buffer.from("leading bytes\n%PDF-1.7").toString("base64"),
  }), true);
  assert.equal(isLegacyRawPdfFilePart({
    type: "file",
    fileName: "statement.bin",
    mediaType: "application/octet-stream",
    base64Data: Buffer.from("opaque").toString("base64"),
  }), false);
});

test("PDF page budgets reserve enough aggregate capacity for every remaining page", (): void => {
  assert.equal(
    calculatePdfPageOutputBudget(PDF_MAXIMUM_TOTAL_JPEG_BYTES, 50),
    Math.floor(PDF_MAXIMUM_TOTAL_JPEG_BYTES / 50),
  );
  assert.equal(
    calculatePdfPageOutputBudget(PDF_MAXIMUM_TOTAL_JPEG_BYTES, 1),
    PDF_MAXIMUM_PAGE_JPEG_BYTES,
  );
  assert.equal(calculatePdfPageOutputBudget(1_000, 4), 250);
  assert.throws((): number => calculatePdfPageOutputBudget(0, 1), RangeError);
});

test("PDF digest and derived base64 size helpers are deterministic", (): void => {
  assert.equal(isSha256Hex("a".repeat(64)), true);
  assert.equal(isSha256Hex("A".repeat(64)), false);
  assert.equal(isSha256Hex(`${"a".repeat(64)}\n`), false);
  assert.equal(getBase64DecodedByteLength(Buffer.from("jpeg").toString("base64")), 4);
  assert.equal(getPdfDerivedImageByteLength({
    type: "pdf",
    fileName: "statement.pdf",
    mediaType: "application/pdf",
    sourceSha256: "a".repeat(64),
    pages: [
      { pageNumber: 1, text: "", jpegBase64Data: Buffer.from("one").toString("base64") },
      { pageNumber: 2, text: "", jpegBase64Data: Buffer.from("two!").toString("base64") },
    ],
  }), 7);
});
