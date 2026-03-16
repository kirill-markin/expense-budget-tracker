import assert from "node:assert/strict";
import test from "node:test";
import { getNextFailedAttemptState, isChallengeExpired, OTP_VERIFY_MAX_ATTEMPTS } from "./otpChallenges.js";

test("getNextFailedAttemptState increments attempts without exhausting before the limit", () => {
  const state = getNextFailedAttemptState(OTP_VERIFY_MAX_ATTEMPTS - 2);

  assert.equal(state.failedAttempts, OTP_VERIFY_MAX_ATTEMPTS - 1);
  assert.equal(state.exhausted, false);
});

test("getNextFailedAttemptState exhausts the challenge on the limit", () => {
  const state = getNextFailedAttemptState(OTP_VERIFY_MAX_ATTEMPTS - 1);

  assert.equal(state.failedAttempts, OTP_VERIFY_MAX_ATTEMPTS);
  assert.equal(state.exhausted, true);
});

test("isChallengeExpired returns true for exhausted challenges", () => {
  const expired = isChallengeExpired({
    expiresAt: "2099-01-01T00:00:00.000Z",
    usedAt: null,
    failedAttempts: OTP_VERIFY_MAX_ATTEMPTS,
  }, Date.UTC(2026, 0, 1));

  assert.equal(expired, true);
});

test("isChallengeExpired returns false for reusable active challenges", () => {
  const expired = isChallengeExpired({
    expiresAt: "2099-01-01T00:00:00.000Z",
    usedAt: null,
    failedAttempts: 0,
  }, Date.UTC(2026, 0, 1));

  assert.equal(expired, false);
});
