import assert from "node:assert/strict";
import test from "node:test";
import { handleMeRouteWithResolver } from "./routeHandlers.js";
import { createAuthenticatedEvent } from "../handlerTestUtils.js";
import type { MachineApiDependencies, MachineRouteContext } from "./types.js";

const createDependencies = (): MachineApiDependencies => ({
  ensureTrustedIdentityProvisioned: async () => undefined,
  loadOpenApiDocument: () => ({}),
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

test("handleMeRoute omits defaultWorkspaceId", async (): Promise<void> => {
  const response = await handleMeRouteWithResolver(
    createContext(),
    async () => ({ workspaceId: "workspace-1", created: true }),
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { data: Record<string, unknown> };
  assert.equal("defaultWorkspaceId" in payload.data, false);
});
