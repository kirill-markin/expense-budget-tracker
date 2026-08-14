import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createQueryResult } from "../handlerTestUtils.js";
import type { UserIdentity } from "../db.js";
import {
  authenticateMcpAccessTokenWithDependencies,
  McpAuthenticationError,
  type McpAuthDependencies,
} from "./auth.js";

const ACCESS_TOKEN = `ebt_at_${"Ab-_".repeat(10)}Ab_`;
const RESOURCE = "https://mcp.example.com/mcp";
const NOW = new Date("2026-08-14T12:00:00.000Z");
const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

type AuthCalls = {
  queries: Array<Readonly<{ text: string; params: ReadonlyArray<unknown> }>>;
  loadedUserIds: Array<string>;
};

const createDependencies = (
  rows: ReadonlyArray<unknown>,
  identity: UserIdentity | null,
  calls: AuthCalls,
): McpAuthDependencies => ({
  query: async (text, params) => {
    calls.queries.push({ text, params });
    return createQueryResult(rows);
  },
  loadTrustedUserIdentity: async (userId) => {
    calls.loadedUserIds.push(userId);
    return identity;
  },
  now: () => NOW,
});

const validRow = (overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
  connection_id: "connection-1",
  user_id: IDENTITY.userId,
  client_id: "ebt_cl_client",
  resource: RESOURCE,
  scopes: ["expenses:read", "expenses:write"],
  expires_at: new Date("2026-08-14T13:00:00.000Z"),
  ...overrides,
});

test("MCP auth hashes the entire opaque access token and loads the existing user identity", async (): Promise<void> => {
  const calls: AuthCalls = { queries: [], loadedUserIds: [] };
  const result = await authenticateMcpAccessTokenWithDependencies(
    ACCESS_TOKEN,
    RESOURCE,
    createDependencies([validRow({})], IDENTITY, calls),
  );

  assert.equal(calls.queries.length, 1);
  assert.match(calls.queries[0]?.text ?? "", /FROM auth[.]validate_oauth_access_token[(][$]1[)]/u);
  assert.deepEqual(calls.queries[0]?.params, [
    createHash("sha256").update(ACCESS_TOKEN).digest("hex"),
  ]);
  assert.deepEqual(calls.loadedUserIds, [IDENTITY.userId]);
  assert.deepEqual(result, {
    connectionId: "connection-1",
    clientId: "ebt_cl_client",
    resource: RESOURCE,
    scopes: ["expenses:read", "expenses:write"],
    identity: IDENTITY,
  });
});

test("MCP auth accepts the canonical read-only scope snapshot", async (): Promise<void> => {
  const calls: AuthCalls = { queries: [], loadedUserIds: [] };
  const result = await authenticateMcpAccessTokenWithDependencies(
    ACCESS_TOKEN,
    RESOURCE,
    createDependencies(
      [validRow({ scopes: ["expenses:read"] })],
      IDENTITY,
      calls,
    ),
  );

  assert.deepEqual(result.scopes, ["expenses:read"]);
  assert.deepEqual(calls.loadedUserIds, [IDENTITY.userId]);
});

test("MCP auth rejects non-OAuth credentials before database access", async (): Promise<void> => {
  for (const token of [
    "EBTA_12345678_0123456789ABCDEFGHJKMNPQRSTV",
    `EBT_AT_${"A".repeat(43)}`,
    `ebt_at_${"A".repeat(42)}`,
  ]) {
    const calls: AuthCalls = { queries: [], loadedUserIds: [] };
    await assert.rejects(
      () => authenticateMcpAccessTokenWithDependencies(
        token,
        RESOURCE,
        createDependencies([], IDENTITY, calls),
      ),
      (error: unknown) => error instanceof McpAuthenticationError,
    );
    assert.deepEqual(calls.queries, []);
  }
});

test("MCP auth rejects missing, expired, and wrong-resource access-token grants", async (): Promise<void> => {
  for (const rows of [
    [],
    [validRow({ expires_at: NOW })],
    [validRow({ resource: "https://mcp.other.example/mcp" })],
  ]) {
    const calls: AuthCalls = { queries: [], loadedUserIds: [] };
    await assert.rejects(
      () => authenticateMcpAccessTokenWithDependencies(
        ACCESS_TOKEN,
        RESOURCE,
        createDependencies(rows, IDENTITY, calls),
      ),
      (error: unknown) => error instanceof McpAuthenticationError,
    );
  }
});

test("MCP auth rejects invalid scope snapshots", async (): Promise<void> => {
  const invalidSnapshots: ReadonlyArray<ReadonlyArray<string>> = [
    ["expenses:write"],
    ["expenses:read", "expenses:read"],
    ["expenses:write", "expenses:read"],
    ["expenses:read", "unsupported:scope"],
  ];

  for (const scopes of invalidSnapshots) {
    const calls: AuthCalls = { queries: [], loadedUserIds: [] };
    await assert.rejects(
      () => authenticateMcpAccessTokenWithDependencies(
        ACCESS_TOKEN,
        RESOURCE,
        createDependencies([validRow({ scopes })], IDENTITY, calls),
      ),
      (error: unknown) =>
        error instanceof McpAuthenticationError
        && error.message === "Invalid OAuth access token",
      scopes.join(","),
    );
    assert.deepEqual(calls.loadedUserIds, [], scopes.join(","));
  }
});

test("MCP auth preserves unrelated database row corruption as an internal error", async (): Promise<void> => {
  const calls: AuthCalls = { queries: [], loadedUserIds: [] };
  await assert.rejects(
    () => authenticateMcpAccessTokenWithDependencies(
      ACCESS_TOKEN,
      RESOURCE,
      createDependencies([validRow({ client_id: 42 })], IDENTITY, calls),
    ),
    (error: unknown) =>
      error instanceof Error
      && !(error instanceof McpAuthenticationError)
      && error.message === "validate_oauth_access_token returned an invalid access-token row",
  );
});

test("MCP auth rejects absent and currently untrusted user identities as invalid tokens", async (): Promise<void> => {
  const cases: ReadonlyArray<Readonly<{
    name: string;
    identity: UserIdentity | null;
  }>> = [
    { name: "missing user", identity: null },
    {
      name: "mismatched user",
      identity: { ...IDENTITY, userId: "user-other" },
    },
    {
      name: "unverified email",
      identity: { ...IDENTITY, emailVerified: false },
    },
    {
      name: "disabled Cognito identity",
      identity: { ...IDENTITY, cognitoEnabled: false },
    },
    {
      name: "non-confirmed Cognito status",
      identity: { ...IDENTITY, cognitoStatus: "FORCE_CHANGE_PASSWORD" },
    },
  ];

  for (const testCase of cases) {
    const calls: AuthCalls = { queries: [], loadedUserIds: [] };
    await assert.rejects(
      () => authenticateMcpAccessTokenWithDependencies(
        ACCESS_TOKEN,
        RESOURCE,
        createDependencies([validRow({})], testCase.identity, calls),
      ),
      (error: unknown) =>
        error instanceof McpAuthenticationError
        && error.message === "Invalid OAuth access token",
      testCase.name,
    );
    assert.deepEqual(calls.loadedUserIds, [IDENTITY.userId], testCase.name);
  }
});
