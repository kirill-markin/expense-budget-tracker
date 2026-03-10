import assert from "node:assert/strict";
import test from "node:test";
import app from "./agentVerifyCode.js";
import { sign } from "../server/crypto.js";

process.env.SESSION_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const makeJsonRequest = (body: Readonly<Record<string, string>>): Request =>
  new Request("http://localhost/api/agent/verify-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("agent verify-code logs rejected expired otp session before Cognito verification", async () => {
  const otpSessionToken = sign(JSON.stringify({
    s: "",
    e: "user@example.com",
    t: Date.now(),
  }));
  const loggedEvents: Array<string> = [];
  const originalConsoleLog = console.log;
  console.log = (...args: ReadonlyArray<unknown>): void => {
    loggedEvents.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const response = await app.request(makeJsonRequest({
      code: "12345678",
      otpSessionToken,
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
