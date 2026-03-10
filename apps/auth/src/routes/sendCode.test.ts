import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "hono";
import { normalizeCrockfordToken } from "../server/crockford.js";
import { createAgentSendCodeApp } from "./agentSendCode.js";
import { createSendCodeApp } from "./sendCode.js";
import type { OtpSendDecision } from "../server/otpRateLimit.js";

process.env.SESSION_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type InitiateEmailOtp = (email: string) => Promise<Readonly<{ session: string }>>;

type SharedLimiterState = Readonly<{
  emailCounts: Map<string, number>;
}>;

const noopDelay = async (): Promise<void> => Promise.resolve();

const makeJsonRequest = (path: string, body: Readonly<Record<string, string>>): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createInitiateEmailOtpStub = (): Readonly<{
  calls: Array<string>;
  initiateEmailOtp: InitiateEmailOtp;
}> => {
  const calls: Array<string> = [];

  const initiateEmailOtp: InitiateEmailOtp = async (email: string) => {
    calls.push(email);
    return { session: `session-for:${email}` };
  };

  return { calls, initiateEmailOtp };
};

const createSharedLimiter = (state: SharedLimiterState) => async (
  normalizedEmail: string,
  _requestIp: string,
): Promise<OtpSendDecision> => {
  const count = state.emailCounts.get(normalizedEmail) ?? 0;
  const decision: OtpSendDecision = count >= 3 ? "blocked_email_limit" : "allowed";
  state.emailCounts.set(normalizedEmail, count + 1);
  return decision;
};

const createSendCodeTestApp = (
  decision: OtpSendDecision,
  initiateEmailOtp: InitiateEmailOtp,
) => createSendCodeApp({
  delay: noopDelay,
  createCsrfToken: () => "csrf-token",
  getClientIp: (_context: Context) => "203.0.113.10",
  initiateEmailOtp,
  checkAndRecordOtpSendDecision: async () => decision,
});

const createAgentSendCodeTestApp = (
  decision: OtpSendDecision,
  initiateEmailOtp: InitiateEmailOtp,
) => createAgentSendCodeApp({
  delay: noopDelay,
  getClientIp: (_context: Context) => "203.0.113.10",
  initiateEmailOtp,
  checkAndRecordOtpSendDecision: async () => decision,
  createAgentOtpChallenge: async (_normalizedEmail: string, cognitoSession: string) => `HANDLE-${cognitoSession}`,
  reissueLatestAgentOtpChallenge: async () => "HANDLE-REISSUED",
  now: () => 123_456,
});

test("browser send-code returns csrf token and otp cookie when allowed", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createSendCodeTestApp("allowed", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/send-code", { email: "User@Example.com" }));
  const body = await response.json() as { ok: boolean; csrfToken: string };

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, csrfToken: "csrf-token" });
  assert.deepEqual(initiateStub.calls, ["user@example.com"]);
  assert.match(response.headers.get("set-cookie") ?? "", /otp_session=/);
});

test("browser send-code returns 429 without Cognito call when email-limited", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createSendCodeTestApp("blocked_email_limit", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/send-code", { email: "user@example.com" }));
  const body = await response.json() as { error: string };

  assert.equal(response.status, 429);
  assert.equal(body.error, "Too many requests — please wait before trying again");
  assert.deepEqual(initiateStub.calls, []);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("browser send-code returns 429 without Cognito call when IP-limited", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createSendCodeTestApp("blocked_ip_limit", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/send-code", { email: "user@example.com" }));
  const body = await response.json() as { error: string };

  assert.equal(response.status, 429);
  assert.equal(body.error, "Too many requests — please wait before trying again");
  assert.deepEqual(initiateStub.calls, []);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("agent send-code returns success envelope without Cognito call when email-limited", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createAgentSendCodeTestApp("blocked_email_limit", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const body = await response.json() as { ok: boolean; data: { otpSessionToken: string } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.otpSessionToken, "HANDLE-REISSUED");
  assert.deepEqual(initiateStub.calls, []);
});

test("agent send-code calls Cognito and returns otp session token when allowed", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createAgentSendCodeTestApp("allowed", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const body = await response.json() as { ok: boolean; data: { otpSessionToken: string } };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.otpSessionToken, "HANDLE-session-for:user@example.com");
  assert.deepEqual(initiateStub.calls, ["user@example.com"]);
});

test("agent send-code returns 429 without Cognito call when IP-limited", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const app = createAgentSendCodeTestApp("blocked_ip_limit", initiateStub.initiateEmailOtp);

  const response = await app.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const body = await response.json() as { ok: boolean; error: { code: string } };

  assert.equal(response.status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "rate_limited");
  assert.deepEqual(initiateStub.calls, []);
});

test("agent and browser send-code routes share limiter state when they use the same checker", async () => {
  const initiateStub = createInitiateEmailOtpStub();
  const sharedLimiterState: SharedLimiterState = {
    emailCounts: new Map<string, number>(),
  };
  const sharedLimiter = createSharedLimiter(sharedLimiterState);

  const agentApp = createAgentSendCodeApp({
    delay: noopDelay,
    getClientIp: (_context: Context) => "203.0.113.10",
    initiateEmailOtp: initiateStub.initiateEmailOtp,
    checkAndRecordOtpSendDecision: sharedLimiter,
    createAgentOtpChallenge: async (_normalizedEmail: string, cognitoSession: string) => `HANDLE-${cognitoSession}`,
    reissueLatestAgentOtpChallenge: async () => "HANDLE-REISSUED",
    now: () => 123_456,
  });
  const browserApp = createSendCodeApp({
    delay: noopDelay,
    createCsrfToken: () => "csrf-token",
    getClientIp: (_context: Context) => "203.0.113.10",
    initiateEmailOtp: initiateStub.initiateEmailOtp,
    checkAndRecordOtpSendDecision: sharedLimiter,
  });

  const firstResponse = await agentApp.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const secondResponse = await agentApp.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const thirdResponse = await agentApp.request(makeJsonRequest("/api/agent/send-code", { email: "user@example.com" }));
  const fourthResponse = await browserApp.request(makeJsonRequest("/api/send-code", { email: "user@example.com" }));
  const fourthBody = await fourthResponse.json() as { error: string };

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(thirdResponse.status, 200);
  assert.equal(fourthResponse.status, 429);
  assert.equal(fourthBody.error, "Too many requests — please wait before trying again");
  assert.deepEqual(initiateStub.calls, ["user@example.com", "user@example.com", "user@example.com"]);
});

test("normalizeCrockfordToken strips separators and uppercases tokens", () => {
  assert.equal(normalizeCrockfordToken("ab cd-ef", "otpSessionToken"), "ABCDEF");
});
