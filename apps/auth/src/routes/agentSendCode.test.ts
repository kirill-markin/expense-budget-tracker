/**
 * What the review-email branch must hand back, and how it must fail.
 *
 * Verify-code resolves `otpSessionToken` as an opaque handle in the challenge
 * store and reads the demo marker off the stored session, so the branch has to
 * persist a challenge carrying that marker, supersede the email's previous one
 * instead of appending, admit no other email, and report a store failure - but
 * never a permanent misconfiguration - as a retryable agent envelope.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Hono } from "hono";
import {
  createDemoAgentOtpSession,
  getDemoEmailPassword,
  isDemoAgentOtpSession,
  resetDemoEmailAccessConfigForTests,
} from "../server/demoEmailAccess.js";
import { createAgentSendCodeApp } from "./agentSendCode.js";

const DEMO_EMAIL_ENV = "DEMO_EMAIL_DOSTIP";
const DEMO_PASSWORD_ENV = "DEMO_PASSWORD_DOSTIP";
const DEMO_EMAIL = "e2e-test@example.com";
const DEMO_PASSWORD = "demo-shared-password";
const NOW_MS = 1_700_000_000_000;

type StoredChallenge = Readonly<{
  handle: string;
  normalizedEmail: string;
  cognitoSession: string;
  nowMs: number;
  used: boolean;
}>;

type ChallengeStoreDouble = Readonly<{
  createSupersedingAgentOtpChallenge: (
    normalizedEmail: string,
    cognitoSession: string,
    nowMs: number,
  ) => Promise<string>;
  storedChallenges: () => ReadonlyArray<StoredChallenge>;
}>;

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const withDemoEmailAccess = async (
  sharedPassword: string | undefined,
  run: () => Promise<void>,
): Promise<void> => {
  const previousEmail = process.env[DEMO_EMAIL_ENV];
  const previousPassword = process.env[DEMO_PASSWORD_ENV];
  process.env[DEMO_EMAIL_ENV] = DEMO_EMAIL;
  restoreEnv(DEMO_PASSWORD_ENV, sharedPassword);
  resetDemoEmailAccessConfigForTests();
  try {
    await run();
  } finally {
    restoreEnv(DEMO_EMAIL_ENV, previousEmail);
    restoreEnv(DEMO_PASSWORD_ENV, previousPassword);
    resetDemoEmailAccessConfigForTests();
  }
};

/**
 * Records what the route asked the store to persist. The supersede itself is
 * pinned against Postgres in `server/otp/otpChallengeStore.postgres.test.ts`.
 */
const createChallengeStoreDouble = (): ChallengeStoreDouble => {
  let challenges: ReadonlyArray<StoredChallenge> = [];

  return {
    createSupersedingAgentOtpChallenge: async (
      normalizedEmail: string,
      cognitoSession: string,
      nowMs: number,
    ): Promise<string> => {
      const handle = `0123456789ABCDEFGHJ${challenges.length}`;
      challenges = [
        ...challenges.map((challenge) =>
          challenge.normalizedEmail === normalizedEmail ? { ...challenge, used: true } : challenge),
        { handle, normalizedEmail, cognitoSession, nowMs, used: false },
      ];
      return handle;
    },
    storedChallenges: (): ReadonlyArray<StoredChallenge> => challenges,
  };
};

const createApp = (
  createSupersedingAgentOtpChallenge: (
    normalizedEmail: string,
    cognitoSession: string,
    nowMs: number,
  ) => Promise<string>,
): Hono =>
  createAgentSendCodeApp({
    delay: async (): Promise<void> => undefined,
    getClientIp: (): string => {
      throw new Error("The review-email branch must short-circuit before the send limiter");
    },
    initiateEmailOtp: async (): Promise<Readonly<{ session: string }>> => {
      throw new Error("The review-email branch must not start a Cognito OTP flow");
    },
    getDemoEmailPassword,
    createDemoAgentOtpSession,
    checkAndRecordOtpSendDecision: async (): Promise<never> => {
      throw new Error("The review-email branch must not be metered");
    },
    createAgentOtpChallenge: async (): Promise<never> => {
      throw new Error("The review-email branch must supersede its challenge, not append one");
    },
    createSupersedingAgentOtpChallenge,
    reissueLatestAgentOtpChallenge: async (): Promise<never> => {
      throw new Error("The review-email branch must not reissue a challenge");
    },
    now: (): number => NOW_MS,
  });

const postDemoSendCode = async (app: Hono): Promise<Response> =>
  await app.request("/api/agent/send-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL }),
  });

const readIssuedToken = async (response: Response): Promise<string> => {
  const body = await response.json() as Readonly<{
    ok: boolean;
    data: Readonly<{ otpSessionToken: string }>;
  }>;
  assert.equal(body.ok, true);
  return body.data.otpSessionToken;
};

test("the review email stores a challenge whose session is the demo marker", async (): Promise<void> => {
  await withDemoEmailAccess(DEMO_PASSWORD, async (): Promise<void> => {
    const store = createChallengeStoreDouble();
    const app = createApp(store.createSupersedingAgentOtpChallenge);

    const response = await postDemoSendCode(app);

    assert.equal(response.status, 200);
    const stored = store.storedChallenges();
    assert.equal(stored.length, 1);
    const challenge = stored[0];
    assert.equal(challenge.normalizedEmail, DEMO_EMAIL);
    assert.equal(challenge.nowMs, NOW_MS);
    // Verify-code skips the code check only when the stored session matches.
    assert.ok(isDemoAgentOtpSession(challenge.normalizedEmail, challenge.cognitoSession));

    const otpSessionToken = await readIssuedToken(response);
    assert.equal(otpSessionToken, challenge.handle);
    assert.notEqual(otpSessionToken, createDemoAgentOtpSession(DEMO_EMAIL));
  });
});

test("a second review-email send leaves a single live challenge", async (): Promise<void> => {
  await withDemoEmailAccess(DEMO_PASSWORD, async (): Promise<void> => {
    const store = createChallengeStoreDouble();
    const app = createApp(store.createSupersedingAgentOtpChallenge);

    const firstToken = await readIssuedToken(await postDemoSendCode(app));
    const secondToken = await readIssuedToken(await postDemoSendCode(app));

    assert.notEqual(firstToken, secondToken);
    const live = store.storedChallenges().filter((challenge) => !challenge.used);
    assert.equal(live.length, 1);
    assert.equal(live[0].handle, secondToken);
  });
});

test("a non-allowlisted email never enters the review-email branch", async (): Promise<void> => {
  await withDemoEmailAccess(DEMO_PASSWORD, async (): Promise<void> => {
    const store = createChallengeStoreDouble();
    const app = createApp(store.createSupersedingAgentOtpChallenge);
    const unhandledErrors: Error[] = [];
    app.onError((error, c) => {
      unhandledErrors.push(error);
      return c.text("", 500);
    });

    const response = await app.request("/api/agent/send-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@production.invalid" }),
    });

    assert.equal(response.status, 500);
    assert.equal(store.storedChallenges().length, 0);
    assert.equal(unhandledErrors.length, 1);
    // The allowlist guard is the only thing keeping a real email off a path that writes a row.
    assert.match(unhandledErrors[0].message, /must short-circuit before the send limiter/u);
  });
});

test("a failed challenge store leaves the review email with an agent error envelope", async (): Promise<void> => {
  await withDemoEmailAccess(DEMO_PASSWORD, async (): Promise<void> => {
    const app = createApp(async (): Promise<never> => {
      throw new Error("remaining connection slots are reserved");
    });

    const response = await postDemoSendCode(app);

    assert.equal(response.status, 500);
    const body = await response.json() as Readonly<{
      ok: boolean;
      data: Readonly<Record<string, unknown>>;
      error: Readonly<{ code: string }>;
    }>;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "auth_backend_unavailable");
    assert.equal(body.data["retryable"], true);
  });
});

test("a demo access misconfiguration is not reported as a retryable outage", async (): Promise<void> => {
  // Missing shared-password configuration can never clear, so the lookup's throw
  // has to stay an unhandled error instead of telling every caller to retry.
  await withDemoEmailAccess(undefined, async (): Promise<void> => {
    const store = createChallengeStoreDouble();
    const app = createApp(store.createSupersedingAgentOtpChallenge);
    const unhandledErrors: Error[] = [];
    app.onError((error, c) => {
      unhandledErrors.push(error);
      return c.text("", 500);
    });

    const response = await postDemoSendCode(app);

    assert.equal(response.status, 500);
    assert.equal(store.storedChallenges().length, 0);
    assert.equal(unhandledErrors.length, 1);
    assert.match(unhandledErrors[0].message, /DEMO_PASSWORD_DOSTIP is required/u);
  });
});
