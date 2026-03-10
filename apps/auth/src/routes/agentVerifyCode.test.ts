import assert from "node:assert/strict";
import test from "node:test";
import { createAgentVerifyCodeApp } from "./agentVerifyCode.js";

const makeJsonRequest = (body: Readonly<Record<string, string>>): Request =>
  new Request("http://localhost/api/agent/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("agent verify-code logs rejected expired otp session before Cognito verification", async () => {
  const app = createAgentVerifyCodeApp({
    lookupAgentOtpChallenge: async () => ({ status: "expired", email: "user@example.com" }),
    verifyEmailOtp: async () => {
      throw new Error("verifyEmailOtp should not be called");
    },
    markAgentOtpChallengeUsed: async () => Promise.resolve(),
    extractIdentityFromIdToken: () => ({ userId: "user-1", email: "user@example.com" }),
    createAgentConnection: async () => ({
      connectionId: "connection-1",
      createdAt: "2026-03-10T00:00:00.000Z",
      label: "codex-desktop",
      apiKey: "ebta_ABCDEFGH_0123456789ABCDEFGHJKMNPQRS",
    }),
    now: () => 123_456,
  });

  const loggedEvents: Array<string> = [];
  const originalConsoleLog = console.log;
  console.log = (...args: ReadonlyArray<unknown>): void => {
    loggedEvents.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const response = await app.request(makeJsonRequest({
      code: "12345678",
      otpSessionToken: "OTP-SESSION",
      label: "codex-desktop",
    }));
    const body = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "expired_otp_session");
    assert.match(
      loggedEvents.join("\n"),
      /"action":"agent_verify_code_rejected".*"reason":"expired_otp_session".*"maskedEmail":"u\*\*\*@example\.com"/,
    );
  } finally {
    console.log = originalConsoleLog;
  }
});

test("agent verify-code returns env-var guidance with the new key", async () => {
  const app = createAgentVerifyCodeApp({
    lookupAgentOtpChallenge: async () => ({
      status: "active",
      email: "user@example.com",
      cognitoSession: "session-1",
    }),
    verifyEmailOtp: async () => ({
      idToken: "header.payload.signature",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
    }),
    markAgentOtpChallengeUsed: async () => Promise.resolve(),
    extractIdentityFromIdToken: () => ({ userId: "user-1", email: "user@example.com" }),
    createAgentConnection: async () => ({
      connectionId: "connection-1",
      createdAt: "2026-03-10T00:00:00.000Z",
      label: "codex-desktop",
      apiKey: "ebta_ABCDEFGH_0123456789ABCDEFGHJKMNPQRS",
    }),
    now: () => 123_456,
  });

  const response = await app.request(makeJsonRequest({
    code: "12345678",
    otpSessionToken: "OTP-SESSION",
    label: "codex-desktop",
  }));
  const body = await response.json() as { ok: boolean; instructions: string; data: { apiKey: string } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.apiKey, "ebta_ABCDEFGH_0123456789ABCDEFGHJKMNPQRS");
  assert.match(body.instructions, /EXPENSE_BUDGET_TRACKER_API_KEY/);
  assert.match(body.instructions, /do not rely on chat history alone/i);
  assert.match(body.instructions, /saved outside this conversation/i);
  assert.match(body.instructions, /new dialog or session on the same machine/i);
  assert.match(body.instructions, /Strongly recommend saving it in a local \.env file/i);
  assert.match(body.instructions, /\.env file as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>'/i);
  assert.match(body.instructions, /ask the user for permission before writing to \.env or any file/i);
  assert.match(body.instructions, /If the user does not allow file writes, export it in the current shell/i);
  assert.match(body.instructions, /Authorization: ApiKey \$EXPENSE_BUDGET_TRACKER_API_KEY/);
  assert.match(body.instructions, /load_account/);
});
