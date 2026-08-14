import assert from "node:assert/strict";
import test from "node:test";
import { createMachineApiHandler } from "../machineApi.js";
import { handleMeRouteWithResolver, handleSqlRouteWithWorkspaceResolver } from "./routeHandlers.js";
import { createAuthenticatedEvent, createEvent } from "../handlerTestUtils.js";
import type { MachineApiDependencies, MachineRouteContext } from "./types.js";

const createDependencies = (): MachineApiDependencies => ({
  ensureTrustedIdentityProvisioned: async () => undefined,
  queryAsTrustedIdentity: async () => {
    throw new Error("queryAsTrustedIdentity should not be called");
  },
  withRestrictedTrustedIdentityContext: async () => {
    throw new Error("withRestrictedTrustedIdentityContext should not be called");
  },
});

const createContext = (): MachineRouteContext => ({
  event: createAuthenticatedEvent({}),
  dependencies: createDependencies(),
  authenticated: {
    identity: {
      userId: "user-1",
      email: "user@example.com",
      emailVerified: true,
      cognitoStatus: "CONFIRMED",
      cognitoEnabled: true,
    },
    connectionId: "connection-1",
    label: "desktop",
    createdAt: "2026-04-01T00:00:00.000Z",
    lastUsedAt: null,
  },
  apiBaseUrl: "https://api.example.com/v1",
  authBaseUrl: "https://auth.example.com",
});

test("conventional OpenAPI paths remain public source-discovery probes", async (): Promise<void> => {
  const handler = createMachineApiHandler({});
  const responses = await Promise.all(
    ["/openapi.json", "/swagger.json"].map((path) =>
      handler(createEvent({ path: `/v1${path}`, resource: path }))),
  );
  const payloads = responses.map((response) => JSON.parse(response.body) as Readonly<Record<string, unknown>>);
  const expectedPayload = {
    ok: true,
    openapiAvailable: false,
    message: "Use runtime discovery and the open-source implementation instead.",
    discoveryUrl: "https://api.example.com/v1/",
    docsUrl: "https://github.com/kirill-markin/expense-budget-tracker/blob/main/README.md",
    source: {
      repositoryUrl: "https://github.com/kirill-markin/expense-budget-tracker",
      sqlApiUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/sql-api/src",
      authRoutesUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/auth/src/routes",
    },
  };

  assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
  assert.deepEqual(payloads, [expectedPayload, expectedPayload]);
});

test("handleMeRoute omits defaultWorkspaceId", async (): Promise<void> => {
  const response = await handleMeRouteWithResolver(
    createContext(),
    async () => ({ workspaceId: "workspace-1", created: true }),
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { data: Record<string, unknown> };
  assert.equal("defaultWorkspaceId" in payload.data, false);
});

test("handleSqlRoute rejects SELECT-only mutations before workspace resolution", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  let trustedQueryCount = 0;
  let restrictedContextCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "DELETE FROM fx_rates_daily WHERE base_currency = 'EUR'" }),
      headers: { Host: "api.example.com" },
      httpMethod: "POST",
      path: "/v1/sql",
      resource: "/sql",
    }),
    dependencies: {
      ...createDependencies(),
      queryAsTrustedIdentity: async () => {
        trustedQueryCount += 1;
        throw new Error("queryAsTrustedIdentity should not be called");
      },
      withRestrictedTrustedIdentityContext: async () => {
        restrictedContextCount += 1;
        throw new Error("withRestrictedTrustedIdentityContext should not be called");
      },
    },
  };

  const response = await handleSqlRouteWithWorkspaceResolver(
    context,
    async (): Promise<string> => {
      workspaceResolutionCount += 1;
      return "workspace-1";
    },
  );
  const payload = JSON.parse(response.body) as {
    instructions: string;
    error: Readonly<{ code: string }>;
  };

  assert.equal(response.statusCode, 400);
  assert.equal(payload.error.code, "read_only_relation_mutation_not_allowed");
  assert.equal(
    payload.instructions,
    "Relation fx_rates_daily is SELECT-only and cannot be targeted by DELETE in restricted SQL. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata.",
  );
  assert.equal(workspaceResolutionCount, 0);
  assert.equal(trustedQueryCount, 0);
  assert.equal(restrictedContextCount, 0);
});

test("handleSqlRoute explains how to replace PostgreSQL escape strings", async (): Promise<void> => {
  let workspaceResolutionCount = 0;
  const context: MachineRouteContext = {
    ...createContext(),
    event: createAuthenticatedEvent({
      body: JSON.stringify({ sql: "SELECT E'value' FROM ledger_entries" }),
      headers: { Host: "api.example.com" },
      httpMethod: "POST",
      path: "/v1/sql",
      resource: "/sql",
    }),
  };

  const response = await handleSqlRouteWithWorkspaceResolver(
    context,
    async (): Promise<string> => {
      workspaceResolutionCount += 1;
      return "workspace-1";
    },
  );
  const payload = JSON.parse(response.body) as {
    instructions: string;
    error: Readonly<{ code: string; message: string }>;
  };

  assert.equal(response.statusCode, 400);
  assert.deepEqual(payload.error, {
    code: "escape_string_literals_not_allowed",
    message: "PostgreSQL escape string literals are not allowed",
  });
  assert.equal(
    payload.instructions,
    "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.",
  );
  assert.equal(workspaceResolutionCount, 0);
});
