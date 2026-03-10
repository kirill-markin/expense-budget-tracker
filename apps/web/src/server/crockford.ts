import crypto from "node:crypto";

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_RE = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/;

/**
 * Creates a fixed-length Crockford Base32 token. The alphabet removes the most
 * ambiguous uppercase letters so agents can retype values more reliably.
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
 * Normalizes human-entered Crockford Base32 by removing separators and forcing
 * uppercase before validation against the strict emitted alphabet.
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
 * Normalizes a prefixed token whose body uses Crockford Base32. This keeps
 * public token formats easy to validate in packages that cannot share app-only
 * modules.
 */
export const normalizePrefixedCrockfordToken = (
  value: string,
  prefix: string,
  bodyLength: number,
  fieldName: string,
): string => {
  const trimmedValue = value.trim();
  if (trimmedValue.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    throw new Error(`${fieldName} must start with ${prefix}`);
  }

  const normalizedBody = normalizeCrockfordToken(trimmedValue.slice(prefix.length), fieldName);
  if (normalizedBody.length !== bodyLength) {
    throw new Error(`${fieldName} body must be ${bodyLength} characters`);
  }

  return `${prefix}${normalizedBody}`;
};

/**
 * Hashes a normalized client token so storage and lookup never require the
 * plaintext secret after the token has been issued.
 */
export const hashOpaqueToken = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");
