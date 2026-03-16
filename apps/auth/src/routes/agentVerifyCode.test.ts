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
    recordAgentOtpChallengeFailure: async () => ({ expired: false }),
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

test("agent verify-code expires the challenge on the fifth invalid code", async () => {
  let failedAttempts = 0;
  let verifyCalls = 0;
  const app = createAgentVerifyCodeApp({
    lookupAgentOtpChallenge: async () => (
      failedAttempts >= 5
        ? { status: "expired", email: "user@example.com" }
        : { status: "active", email: "user@example.com", cognitoSession: "session-1" }
    ),
    verifyEmailOtp: async () => {
      verifyCalls += 1;
      const error = new Error("wrong code") as Error & { cognitoType: string };
      error.cognitoType = "CodeMismatchException";
      throw error;
    },
    recordAgentOtpChallengeFailure: async () => {
      failedAttempts += 1;
      return { expired: failedAttempts >= 5 };
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

  for (let index = 0; index < 4; index++) {
    const response = await app.request(makeJsonRequest({
      code: "12345678",
      otpSessionToken: "OTP-SESSION",
      label: "codex-desktop",
    }));
    const body = await response.json() as { error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "invalid_code");
  }

  const fifthResponse = await app.request(makeJsonRequest({
    code: "12345678",
    otpSessionToken: "OTP-SESSION",
    label: "codex-desktop",
  }));
  const fifthBody = await fifthResponse.json() as { error: { code: string } };
  assert.equal(fifthResponse.status, 400);
  assert.equal(fifthBody.error.code, "expired_otp_session");

  const sixthResponse = await app.request(makeJsonRequest({
    code: "12345678",
    otpSessionToken: "OTP-SESSION",
    label: "codex-desktop",
  }));
  const sixthBody = await sixthResponse.json() as { error: { code: string } };
  assert.equal(sixthResponse.status, 400);
  assert.equal(sixthBody.error.code, "expired_otp_session");
  assert.equal(verifyCalls, 5);
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
    recordAgentOtpChallengeFailure: async () => ({ expired: false }),
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
  const body = await response.json() as {
    ok: boolean;
    instructions: string;
    data: { apiKey: string };
    actions: Array<{ name: string }>;
  };

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
  assert.match(body.instructions, /\/v1\/workspaces/);
  assert.match(body.instructions, /\/workspaces\/\{workspaceId\}\/select/);
  assert.deepEqual(body.actions, [
    {
      name: "load_account",
      method: "GET",
      url: "http://localhost/v1/me",
      auth: "ApiKey",
    },
    {
      name: "list_workspaces",
      method: "GET",
      url: "http://localhost/v1/workspaces",
      auth: "ApiKey",
    },
    {
      name: "select_workspace",
      method: "POST",
      urlTemplate: "http://localhost/v1/workspaces/{workspaceId}/select",
      auth: "ApiKey",
    },
    {
      name: "schema",
      method: "GET",
      url: "http://localhost/v1/schema",
      auth: "ApiKey",
    },
  ]);
});
