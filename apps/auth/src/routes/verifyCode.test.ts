import assert from "node:assert/strict";
import test from "node:test";
import { createVerifyCodeApp } from "./verifyCode.js";
import type { BrowserOtpChallengeLookup } from "../server/otpChallengeStore.js";

type LookupState = Readonly<{
  status: "active" | "expired" | "invalid" | "used";
  failedAttempts: number;
}>;

const makeJsonRequest = (
  body: Readonly<Record<string, string>>,
  otpSessionToken: string | null,
): Request => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (otpSessionToken !== null) {
    headers.set("Cookie", `otp_session=${otpSessionToken}`);
  }

  return new Request("http://localhost/api/verify-code", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

const createLookup = (state: LookupState): ((otpSessionToken: string) => Promise<BrowserOtpChallengeLookup>) =>
  async (_otpSessionToken: string) => {
    if (state.status === "invalid") {
      return { status: "invalid" };
    }
    if (state.status === "expired") {
      return { status: "expired", email: "user@example.com" };
    }
    if (state.status === "used") {
      return { status: "used", email: "user@example.com" };
    }
    return {
      status: "active",
      email: "user@example.com",
      cognitoSession: "session-1",
      csrfToken: "csrf-token",
    };
  };

test("browser verify-code returns expired when cookie is missing", async () => {
  const app = createVerifyCodeApp({
    lookupBrowserOtpChallenge: async () => ({ status: "invalid" }),
    verifyEmailOtp: async () => {
      throw new Error("verifyEmailOtp should not be called");
    },
    recordBrowserOtpChallengeFailure: async () => ({ expired: false }),
    markBrowserOtpChallengeUsed: async () => Promise.resolve(),
    now: () => 123_456,
  });

  const response = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "csrf-token" }, null));
  const body = await response.json() as { error: string };

  assert.equal(response.status, 400);
  assert.equal(body.error, "Session expired — request a new code");
});

test("browser verify-code does not count malformed code or csrf mismatch", async () => {
  let failureCalls = 0;
  const app = createVerifyCodeApp({
    lookupBrowserOtpChallenge: createLookup({ status: "active", failedAttempts: 0 }),
    verifyEmailOtp: async () => {
      throw new Error("verifyEmailOtp should not be called");
    },
    recordBrowserOtpChallengeFailure: async () => {
      failureCalls += 1;
      return { expired: false };
    },
    markBrowserOtpChallengeUsed: async () => Promise.resolve(),
    now: () => 123_456,
  });

  const malformedResponse = await app.request(makeJsonRequest({ code: "123", csrfToken: "csrf-token" }, "HANDLE-1"));
  const malformedBody = await malformedResponse.json() as { error: string };
  assert.equal(malformedResponse.status, 400);
  assert.equal(malformedBody.error, "Enter an 8-digit code");

  const csrfResponse = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "wrong-token" }, "HANDLE-1"));
  const csrfBody = await csrfResponse.json() as { error: string };
  assert.equal(csrfResponse.status, 400);
  assert.equal(csrfBody.error, "Session expired — request a new code");

  assert.equal(failureCalls, 0);
});

test("browser verify-code expires the challenge on the fifth invalid code", async () => {
  let failedAttempts = 0;
  const app = createVerifyCodeApp({
    lookupBrowserOtpChallenge: async () => ({
      status: failedAttempts >= 5 ? "expired" : "active",
      email: "user@example.com",
      cognitoSession: "session-1",
      csrfToken: "csrf-token",
    } as BrowserOtpChallengeLookup),
    verifyEmailOtp: async () => {
      const error = new Error("wrong code") as Error & { cognitoType: string };
      error.cognitoType = "CodeMismatchException";
      throw error;
    },
    recordBrowserOtpChallengeFailure: async () => {
      failedAttempts += 1;
      return { expired: failedAttempts >= 5 };
    },
    markBrowserOtpChallengeUsed: async () => Promise.resolve(),
    now: () => 123_456,
  });

  for (let index = 0; index < 4; index++) {
    const response = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "csrf-token" }, "HANDLE-1"));
    const body = await response.json() as { error: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, "Verification failed — please try again");
  }

  const fifthResponse = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "csrf-token" }, "HANDLE-1"));
  const fifthBody = await fifthResponse.json() as { error: string };
  assert.equal(fifthResponse.status, 400);
  assert.equal(fifthBody.error, "Session expired — request a new code");

  const sixthResponse = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "csrf-token" }, "HANDLE-1"));
  const sixthBody = await sixthResponse.json() as { error: string };
  assert.equal(sixthResponse.status, 400);
  assert.equal(sixthBody.error, "Session expired — request a new code");
});

test("browser verify-code marks the challenge used and clears the cookie on success", async () => {
  let markedUsed = false;
  const app = createVerifyCodeApp({
    lookupBrowserOtpChallenge: createLookup({ status: "active", failedAttempts: 0 }),
    verifyEmailOtp: async () => ({
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }),
    recordBrowserOtpChallengeFailure: async () => ({ expired: false }),
    markBrowserOtpChallengeUsed: async () => {
      markedUsed = true;
    },
    now: () => 123_456,
  });

  const response = await app.request(makeJsonRequest({ code: "12345678", csrfToken: "csrf-token" }, "HANDLE-1"));
  const body = await response.json() as { ok: boolean };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(markedUsed, true);
  assert.match(response.headers.get("set-cookie") ?? "", /otp_session=;/);
});
