import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCrockfordToken } from "./crockford.js";

test("normalizeCrockfordToken strips separators and uppercases values", () => {
  assert.equal(normalizeCrockfordToken("ab-cd ef", "token"), "ABCDEF");
});

test("normalizeCrockfordToken rejects invalid characters", () => {
  assert.throws(() => normalizeCrockfordToken("hello", "token"), /must use Crockford Base32 characters/);
});
