import assert from "node:assert/strict";
import test from "node:test";
import { postAgentWorkspaceDeleteRouteWithDeps } from "@/app/api/agent/workspaces/[workspaceId]/delete/route";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import { WorkspaceDeletionRequiresSingleMemberError } from "@/server/workspaces";

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

test("postAgentWorkspaceDeleteRouteWithDeps returns 403 when workspace has multiple members", async (): Promise<void> => {
  const response = await postAgentWorkspaceDeleteRouteWithDeps(
    createRequest("Shared"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      getWorkspaceForTrustedIdentity: async () => ({ workspaceId: "workspace-1", name: "Shared" }),
      deleteWorkspaceForTrustedIdentity: async () => {
        throw new WorkspaceDeletionRequiresSingleMemberError(2);
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    data: {},
    actions: [],
    instructions: "Workspace deletion is only allowed when the workspace has exactly one member. Remove other participants and retry.",
    error: {
      code: "workspace_delete_requires_single_member",
      message: "Workspace deletion is only allowed when the workspace has exactly one member; found 2.",
    },
  });
});

test("postAgentWorkspaceDeleteRouteWithDeps allows single-member workspace deletion", async (): Promise<void> => {
  const response = await postAgentWorkspaceDeleteRouteWithDeps(
    createRequest("Project Alpha"),
    { params: Promise.resolve({ workspaceId: "workspace-a0f0f8e4" }) },
    {
      authenticateAgentRequest: async () => createAuthenticatedRequest(),
      getWorkspaceForTrustedIdentity: async () => ({ workspaceId: "workspace-a0f0f8e4", name: "Project Alpha" }),
      deleteWorkspaceForTrustedIdentity: async () => ({ workspaceId: "workspace-a0f0f8e4", name: "Project Alpha" }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: {
      deleted: {
        workspaceId: "workspace-a0f0f8e4",
        name: "Project Alpha",
      },
    },
    actions: [],
    instructions: "Workspace and all its data have been permanently deleted.",
  });
});
