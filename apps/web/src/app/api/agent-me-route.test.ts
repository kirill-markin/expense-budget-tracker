import assert from "node:assert/strict";
import test from "node:test";
import { getAgentMeRouteWithDeps } from "./agent/me/route";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";

const createAuthenticatedRequest = (): AgentAuthenticatedRequest => ({
  transport: "api_key",
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
});

test("getAgentMeRouteWithDeps returns account context without defaultWorkspaceId", async (): Promise<void> => {
  const response = await getAgentMeRouteWithDeps(
    new Request("http://localhost/api/agent/me"),
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      resolveWorkspaceForIdentity: async () => ({
        workspaceId: "workspace-1",
        name: "Main",
        created: true,
        requestedWorkspaceAccessible: false,
      }),
    },
  );

  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.ok, true);
  const data = payload.data as Record<string, unknown>;
  assert.equal("defaultWorkspaceId" in data, false);
});
