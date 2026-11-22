import assert from "node:assert/strict";
import test from "node:test";
import type { UserIdentity } from "../db.js";
import { createAuthenticatedEvent, createEvent } from "../handlerTestUtils.js";
import type { SqlApiLogEvent } from "../logger.js";
import { createMachineApiHandler } from "../machineApi.js";
import { resolveAuthenticatedContext } from "./request.js";
import { RETRYABLE_ERROR_MESSAGE } from "./responses.js";

const STORED_IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

const loadStored = (
  identity: UserIdentity | null,
  calls: Array<string>,
): ((userId: string) => Promise<UserIdentity | null>) => async (userId) => {
  calls.push(userId);
  return identity;
};

test("a request without an authorizer context is unauthenticated and reads no account state", async (): Promise<void> => {
  const calls: Array<string> = [];

  const resolution = await resolveAuthenticatedContext(createEvent({}), loadStored(STORED_IDENTITY, calls));

  assert.deepEqual(resolution, { outcome: "missing_api_key" });
  assert.deepEqual(calls, []);
});

test("an unrevoked ApiKey for a disabled account does not authenticate", async (): Promise<void> => {
  const calls: Array<string> = [];

  const resolution = await resolveAuthenticatedContext(
    createAuthenticatedEvent({}),
    loadStored({ ...STORED_IDENTITY, cognitoEnabled: false }, calls),
  );

  assert.deepEqual(resolution, { outcome: "account_disabled", userId: "user-1" });
  assert.deepEqual(calls, ["user-1"]);
});

test("an unrevoked ApiKey for a deleted account does not authenticate", async (): Promise<void> => {
  const resolution = await resolveAuthenticatedContext(
    createAuthenticatedEvent({}),
    loadStored(null, []),
  );

  assert.deepEqual(resolution, { outcome: "account_disabled", userId: "user-1" });
});

test("the authenticated identity carries the stored account state, not a hardcoded CONFIRMED", async (): Promise<void> => {
  const resolution = await resolveAuthenticatedContext(
    createAuthenticatedEvent({}),
    loadStored({ ...STORED_IDENTITY, cognitoStatus: "PROXY" }, []),
  );

  assert.equal(resolution.outcome, "authenticated");
  assert.deepEqual(
    resolution.outcome === "authenticated" ? resolution.authenticated.identity : null,
    {
      userId: "user-1",
      email: "user@example.com",
      emailVerified: true,
      cognitoStatus: "PROXY",
      cognitoEnabled: true,
    },
  );
});

test("the authenticated identity carries the stored email_verified, which an ApiKey never proves", async (): Promise<void> => {
  const resolution = await resolveAuthenticatedContext(
    createAuthenticatedEvent({}),
    loadStored({ ...STORED_IDENTITY, emailVerified: false }, []),
  );

  // The MCP access-token gate admits on this column. A key holder it refused
  // must not be able to raise it back with one /v1 call.
  assert.equal(
    resolution.outcome === "authenticated" ? resolution.authenticated.identity.emailVerified : null,
    false,
  );
});

test("the machine API answers 403 for a disabled account and provisions nothing", async (): Promise<void> => {
  const logged: Array<SqlApiLogEvent> = [];
  const handler = createMachineApiHandler({
    log: (event) => { logged.push(event); },
    loadTrustedUserIdentityBeforeDeadline: async () => ({ ...STORED_IDENTITY, cognitoEnabled: false }),
    recordOpenDayOncePerDay: async () => {
      throw new Error("recordOpenDayOncePerDay should not be called");
    },
    ensureTrustedIdentityProvisioned: async () => {
      throw new Error("ensureTrustedIdentityProvisioned should not be called");
    },
    resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => {
      throw new Error("resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline should not be called");
    },
  });

  const response = await handler(createAuthenticatedEvent({ path: "/v1/me", resource: "/me" }));

  assert.equal(response.statusCode, 403);
  const payload = JSON.parse(response.body) as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "account_disabled");
  // An operator who disables a row needs a CloudWatch signal that the refusal fired.
  assert.deepEqual(logged, [{ domain: "sql_api", action: "agent_account_disabled", userId: "user-1" }]);
});

test("an authenticated request records the person's api open day before routing", async (): Promise<void> => {
  const recorded: Array<Readonly<{ userId: string; surface: string }>> = [];
  const handler = createMachineApiHandler({
    loadTrustedUserIdentityBeforeDeadline: async () => STORED_IDENTITY,
    recordOpenDayOncePerDay: async (userId, surface) => {
      recorded.push({ userId, surface });
    },
  });

  const response = await handler(createAuthenticatedEvent({ path: "/v1/unknown", resource: "/unknown" }));

  assert.equal(response.statusCode, 404);
  assert.deepEqual(recorded, [{ userId: "user-1", surface: "api" }]);
});

test("a failed open-day write answers the same retryable envelope as the account-state read", async (): Promise<void> => {
  const handler = createMachineApiHandler({
    log: (): void => undefined,
    loadTrustedUserIdentityBeforeDeadline: async () => STORED_IDENTITY,
    recordOpenDayOncePerDay: async () => {
      throw new Error("insert or update on table user_open_days violates foreign key constraint");
    },
  });

  const response = await handler(createAuthenticatedEvent({ path: "/v1/me", resource: "/me" }));

  assert.equal(response.statusCode, 500);
  const payload = JSON.parse(response.body) as { data: { retryable: boolean }; error: { code: string } };
  assert.equal(payload.data.retryable, true);
  assert.equal(payload.error.code, "agent_auth_unavailable");
});

test("a database failure during the account-state read answers a retryable envelope", async (): Promise<void> => {
  const logged: Array<SqlApiLogEvent> = [];
  const handler = createMachineApiHandler({
    log: (event) => { logged.push(event); },
    loadTrustedUserIdentityBeforeDeadline: async () => {
      throw new Error("connect ECONNREFUSED 10.0.1.23:5432");
    },
  });

  const response = await handler(createAuthenticatedEvent({ path: "/v1/me", resource: "/me" }));

  assert.equal(response.statusCode, 500);
  const payload = JSON.parse(response.body) as {
    ok: boolean;
    data: { retryable: boolean };
    error: { code: string; message: string };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.data.retryable, true);
  assert.equal(payload.error.code, "agent_auth_unavailable");
  // This path answers before any route authorization, so the cause stays in
  // the log: the caller gets the retryable contract, not the database host.
  assert.equal(payload.error.message, RETRYABLE_ERROR_MESSAGE);
  assert.doesNotMatch(response.body, /10\.0\.1\.23/u);
  // An auth-path outage must be distinguishable from a wave of revocations,
  // and the redacted cause has to survive somewhere, so both events reach the
  // one injected logger.
  assert.deepEqual(logged, [
    { domain: "sql_api", action: "agent_auth_unavailable", errorType: "error" },
    {
      domain: "sql_api",
      action: "agent_request_unavailable",
      code: "agent_auth_unavailable",
      errorType: "error",
      message: "connect ECONNREFUSED 10.0.1.23:5432",
    },
  ]);
});

test("an unauthenticated request still answers 401 while the database is down", async (): Promise<void> => {
  const handler = createMachineApiHandler({
    loadTrustedUserIdentityBeforeDeadline: async () => {
      throw new Error("pool exhausted");
    },
    recordOpenDayOncePerDay: async () => {
      throw new Error("recordOpenDayOncePerDay should not be called");
    },
  });

  const response = await handler(createEvent({ path: "/v1/me", resource: "/me" }));

  assert.equal(response.statusCode, 401);
  const payload = JSON.parse(response.body) as { error: { code: string } };
  assert.equal(payload.error.code, "missing_api_key");
});

test("discovery routes answer an authenticated request without recording an open day", async (): Promise<void> => {
  const handler = createMachineApiHandler({
    loadTrustedUserIdentityBeforeDeadline: async () => {
      throw new Error("loadTrustedUserIdentityBeforeDeadline should not be called");
    },
    recordOpenDayOncePerDay: async () => {
      throw new Error("recordOpenDayOncePerDay should not be called");
    },
  });

  const responses = await Promise.all(
    ["/", "/openapi.json"].map((path) =>
      handler(createAuthenticatedEvent({ path: `/v1${path}`, resource: path }))),
  );

  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
});
