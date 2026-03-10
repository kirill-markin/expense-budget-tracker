import assert from "node:assert/strict";
import test from "node:test";
import { createCrockfordToken, normalizeCrockfordToken } from "./crockford.js";

test("createCrockfordToken emits the requested length with the expected alphabet", () => {
  const token = createCrockfordToken(20);

  assert.equal(token.length, 20);
  assert.match(token, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]+$/);
});

test("normalizeCrockfordToken rejects invalid characters", () => {
  assert.throws(
    () => normalizeCrockfordToken("bad!", "otpSessionToken"),
    /Crockford Base32/,
  );
});
