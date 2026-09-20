import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import type { QueryResult } from "pg";

import { ACCOUNT_DISABLED_INSTRUCTIONS, ACCOUNT_DISABLED_MESSAGE } from "@expense-budget-tracker/agent-shared";

import {
  authenticateAgentRequestWithDependencies,
  getAgentAuthError,
  type AgentApiKeyAuthDependencies,
  type AgentAuthError,
  type StoredAccountState,
} from "@/server/agent/apiKeyAuth";
import { API_KEY_INSTRUCTIONS, jsonAgentAuthError } from "@/server/agent/responses";

const KEY_ID = "ABCDEFGH";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ2345";
const API_KEY = `EBTA_${KEY_ID}_${SECRET}`;

const KEY_ROW = {
  connection_id: "connection-1",
  user_id: "user-1",
  email: "user@example.com",
  key_hash: crypto.createHash("sha256").update(SECRET).digest("hex"),
  revoked_at: null,
  last_used_at: null,
  label: "codex-desktop",
  created_at: "2026-04-01T00:00:00.000Z",
};

const result = (rows: ReadonlyArray<unknown>): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createRequest = (): Request =>
  new Request("https://app.example.com/api/agent/me", {
    headers: { authorization: `ApiKey ${API_KEY}` },
  });

type LoggedEvent = Parameters<AgentApiKeyAuthDependencies["log"]>[0];

const createDependencies = (
  storedAccount: StoredAccountState | null,
  touchedConnections: Array<string>,
  loggedEvents: Array<LoggedEvent> = [],
): AgentApiKeyAuthDependencies => ({
  query: async (text, params) => {
    if (text.includes("validate_agent_api_key")) {
      return result([KEY_ROW]);
    }
    if (text.includes("touch_agent_api_key_usage")) {
      touchedConnections.push(String(params[0]));
      return result([]);
    }
    throw new Error(`Unexpected query in test: ${text}`);
  },
  loadStoredAccountState: async () => storedAccount,
  log: (event) => { loggedEvents.push(event); },
});

test("an unrevoked ApiKey for a disabled account is refused and the refusal is logged", async (): Promise<void> => {
  const touchedConnections: Array<string> = [];
  const loggedEvents: Array<LoggedEvent> = [];
  const dependencies = createDependencies(
    { cognitoStatus: "CONFIRMED", cognitoEnabled: false },
    touchedConnections,
    loggedEvents,
  );

  await assert.rejects(
    () => authenticateAgentRequestWithDependencies(createRequest(), dependencies),
    (error: unknown): boolean => {
      const authError = getAgentAuthError(error);
      return authError !== null
        && authError.code === "account_disabled"
        && authError.status === 403
        && authError.message === ACCOUNT_DISABLED_MESSAGE;
    },
  );
  assert.deepEqual(touchedConnections, []);
  // An operator who disables a row needs a CloudWatch signal that the refusal fired.
  assert.deepEqual(loggedEvents, [{ domain: "auth", action: "agent_account_disabled", userId: "user-1" }]);
});

test("a failed account-state read is logged apart from a refusal", async (): Promise<void> => {
  const touchedConnections: Array<string> = [];
  const loggedEvents: Array<LoggedEvent> = [];
  const dependencies: AgentApiKeyAuthDependencies = {
    ...createDependencies(null, touchedConnections, loggedEvents),
    loadStoredAccountState: async () => {
      throw new Error("connect ECONNREFUSED 10.0.1.23:5432");
    },
  };

  await assert.rejects(
    () => authenticateAgentRequestWithDependencies(createRequest(), dependencies),
    (error: unknown): boolean => getAgentAuthError(error) === null
      && error instanceof Error
      && error.message === "connect ECONNREFUSED 10.0.1.23:5432",
  );
  assert.deepEqual(touchedConnections, []);
  // The routes answer this as an unavailable envelope, so without its own
  // event an auth-path outage would read as a wave of revocations.
  assert.deepEqual(loggedEvents, [{
    domain: "auth",
    action: "agent_auth_unavailable",
    error: "connect ECONNREFUSED 10.0.1.23:5432",
  }]);
});

test("an unrevoked ApiKey for a deleted account is refused", async (): Promise<void> => {
  const dependencies = createDependencies(null, []);

  await assert.rejects(
    () => authenticateAgentRequestWithDependencies(createRequest(), dependencies),
    (error: unknown): boolean => getAgentAuthError(error)?.code === "account_disabled",
  );
});

test("the authenticated identity carries the stored account state, not a hardcoded CONFIRMED", async (): Promise<void> => {
  const touchedConnections: Array<string> = [];
  const dependencies = createDependencies(
    { cognitoStatus: "PROXY", cognitoEnabled: true },
    touchedConnections,
  );

  const authenticated = await authenticateAgentRequestWithDependencies(createRequest(), dependencies);

  assert.deepEqual(authenticated.identity, {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "PROXY",
    cognitoEnabled: true,
  });
  assert.deepEqual(touchedConnections, ["connection-1"]);
});

test("an empty stored status is refused as an inactive account, not a server error", async (): Promise<void> => {
  const touchedConnections: Array<string> = [];
  const dependencies = createDependencies(
    { cognitoStatus: "", cognitoEnabled: true },
    touchedConnections,
  );

  await assert.rejects(
    () => authenticateAgentRequestWithDependencies(createRequest(), dependencies),
    (error: unknown): boolean => {
      const authError = getAgentAuthError(error);
      return authError !== null && authError.code === "account_disabled" && authError.status === 403;
    },
  );
  assert.deepEqual(touchedConnections, []);
});

const createAuthError = (code: string, status: number, message: string): AgentAuthError => {
  const error = new Error(message) as AgentAuthError;
  error.code = code;
  error.status = status;
  return error;
};

test("a refused disabled account is told to ask the operator, never to create another key", async (): Promise<void> => {
  const response = jsonAgentAuthError(
    createAuthError("account_disabled", 403, ACCOUNT_DISABLED_MESSAGE),
  );

  assert.equal(response.status, 403);
  const payload = await response.json() as { instructions: string };
  assert.equal(payload.instructions, ACCOUNT_DISABLED_INSTRUCTIONS);
});

test("other auth failures keep the ApiKey setup instructions", async (): Promise<void> => {
  const response = jsonAgentAuthError(createAuthError("invalid_api_key", 401, "Invalid ApiKey"));

  assert.equal(response.status, 401);
  const payload = await response.json() as { instructions: string };
  assert.equal(payload.instructions, API_KEY_INSTRUCTIONS);
});
