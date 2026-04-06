import assert from "node:assert/strict";
import test from "node:test";
import { postAgentWorkspaceDeleteRouteWithDeps } from "@/app/api/agent/workspaces/[workspaceId]/delete/route";
import type { AgentAuthenticatedRequest } from "@/server/agentApiKeyAuth";
import { SharedWorkspaceDeletionDisabledError } from "@/server/workspaces";

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

const createRequest = (confirmText: string): Request =>
  new Request("http://localhost/api/agent/workspaces/workspace-1/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirmText }),
  });

test("postAgentWorkspaceDeleteRouteWithDeps returns 403 for shared workspace deletion", async (): Promise<void> => {
  const response = await postAgentWorkspaceDeleteRouteWithDeps(
    createRequest("Shared"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      getWorkspaceForTrustedIdentity: async () => ({ workspaceId: "workspace-1", name: "Shared" }),
      deleteWorkspaceForTrustedIdentity: async () => {
        throw new SharedWorkspaceDeletionDisabledError();
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    data: {},
    actions: [],
    instructions: "Only personal workspaces can be deleted right now. Shared workspace deletion will require dedicated admin roles.",
    error: {
      code: "shared_workspace_delete_disabled",
      message: "Shared workspace deletion is disabled until workspace admin roles are introduced",
    },
  });
});

test("postAgentWorkspaceDeleteRouteWithDeps allows personal workspace deletion", async (): Promise<void> => {
  const response = await postAgentWorkspaceDeleteRouteWithDeps(
    createRequest("Personal"),
    { params: Promise.resolve({ workspaceId: "user-1" }) },
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      getWorkspaceForTrustedIdentity: async () => ({ workspaceId: "user-1", name: "Personal" }),
      deleteWorkspaceForTrustedIdentity: async () => ({ workspaceId: "user-1", name: "Personal" }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      deleted: {
        workspaceId: "user-1",
        name: "Personal",
      },
    },
    actions: [],
    instructions: "Workspace and all its data have been permanently deleted.",
  });
});
