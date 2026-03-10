import crypto from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/;

/**
 * Creates a fixed-length Crockford Base32 token. The alphabet avoids visually
 * ambiguous characters so humans and LLMs can retype values more reliably.
 */
export const createCrockfordToken = (length: number): string => {
  const chars: Array<string> = [];
  while (chars.length < length) {
    const bytes = crypto.randomBytes(length - chars.length);
    for (const byte of bytes) {
      chars.push(CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length] ?? "");
    }
  }

  return chars.join("");
};

/**
 * Normalizes a human-entered Crockford token by removing separators and
 * uppercasing the value before strict alphabet validation.
 */
export const normalizeCrockfordToken = (
  value: string,
  fieldName: string,
): string => {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  if (normalized === "") {
    throw new Error(`${fieldName} must not be empty`);
  }

  if (!CROCKFORD_RE.test(normalized)) {
    throw new Error(`${fieldName} must use Crockford Base32 characters`);
  }

  return normalized;
};

/**
 * Hashes a client-visible opaque token so the server can look it up without
 * persisting the plaintext value after issuance.
 */
export const hashOpaqueToken = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");
