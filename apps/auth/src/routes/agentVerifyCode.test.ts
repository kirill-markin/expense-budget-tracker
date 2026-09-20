/**
 * How verify-code reports a failure the caller cannot retry away.
 *
 * Key creation calls `auth.sync_authenticated_user`, which raises the
 * `idx_users_email` collision when the address already belongs to another
 * subject. The collision is permanent, so it must not reach the agent as the
 * retryable `verification_unavailable` the default mapping returns.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Hono } from "hono";
import { createAgentVerifyCodeApp } from "./agentVerifyCode.js";
import type { AgentConnectionResult } from "../server/agent/agentApiKeys.js";
import type { TokenResult } from "../server/cognitoAuth.js";
import type { AgentOtpChallengeLookup } from "../server/otp/otpChallengeStore.js";

const TOKENS: TokenResult = {
  idToken: "id-token",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresIn: 3600,
};

const EMAIL = "owner@example.com";
const USER_ID = "user-1";

const createApp = (createAgentConnection: () => Promise<AgentConnectionResult>): Hono =>
  createAgentVerifyCodeApp({
    lookupAgentOtpChallenge: async (): Promise<AgentOtpChallengeLookup> => ({
      status: "active",
      email: EMAIL,
      cognitoSession: "cognito-session",
    }),
    verifyEmailOtp: async (): Promise<TokenResult> => TOKENS,
    signInWithPassword: async (): Promise<TokenResult> => TOKENS,
    recordAgentOtpChallengeFailure: async (): Promise<Readonly<{ expired: boolean }>> => ({ expired: false }),
    markAgentOtpChallengeUsed: async (): Promise<void> => undefined,
    extractIdentityFromIdToken: (): Readonly<{ userId: string; email: string }> => ({
      userId: USER_ID,
      email: EMAIL,
    }),
    getDemoEmailPassword: (): string | null => null,
    isDemoAgentOtpSession: (): boolean => false,
    createAgentConnection,
    now: (): number => 1_700_000_000_000,
  });

const postVerifyCode = async (app: Hono): Promise<Response> =>
  await app.request("/api/agent/verify-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "12345678", otpSessionToken: "otp-session", label: "laptop" }),
  });

test("an email owned by another subject is a permanent conflict, not a retryable outage", async (): Promise<void> => {
  const hint = "Accounts are never linked automatically: sign in with the subject that owns this email.";
  const message = "This email is already registered to a different user";
  const app = createApp(async (): Promise<AgentConnectionResult> => {
    throw Object.assign(new Error(message), { code: "23505", constraint: "idx_users_email", hint });
  });

  const response = await postVerifyCode(app);

  assert.equal(response.status, 409);
  const body = await response.json() as Readonly<{
    ok: boolean;
    data: Readonly<Record<string, unknown>>;
    instructions: string;
    error: Readonly<{ code: string; message: string }>;
  }>;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "email_already_registered");
  assert.equal(body.error.message, message);
  assert.equal(body.instructions, hint);
  assert.equal(body.data["retryable"], false);
});

test("an unrelated key-creation failure stays a retryable server error", async (): Promise<void> => {
  const app = createApp(async (): Promise<AgentConnectionResult> => {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  });

  const response = await postVerifyCode(app);

  assert.equal(response.status, 500);
  const body = await response.json() as Readonly<{
    data: Readonly<Record<string, unknown>>;
    error: Readonly<{ code: string }>;
  }>;
  assert.equal(body.error.code, "verification_unavailable");
  assert.equal(body.data["retryable"], true);
});
