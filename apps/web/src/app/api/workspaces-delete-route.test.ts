import assert from "node:assert/strict";
import test from "node:test";
import { postDeleteWorkspaceRouteWithDeps } from "@/app/api/workspaces/[workspaceId]/delete/route";
import { WorkspaceDeletionRequiresSingleMemberError } from "@/server/workspaces";

const createRequest = (confirmText: string): Request =>
  new Request("http://localhost/api/workspaces/workspace-1/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-2",
    },
    body: JSON.stringify({ confirmText }),
  });

test("postDeleteWorkspaceRouteWithDeps returns 403 when workspace has multiple members", async (): Promise<void> => {
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Shared"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-1", name: "Shared" }],
      deleteWorkspaceChatFileObjects: async () => undefined,
      deleteWorkspace: async () => {
        throw new WorkspaceDeletionRequiresSingleMemberError(2);
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Workspace deletion is only allowed when the workspace has exactly one member; found 2.");
});

test("postDeleteWorkspaceRouteWithDeps returns 403 when chat file cleanup refuses a shared workspace", async (): Promise<void> => {
  let deleteCalled = false;
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Shared"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-1", name: "Shared" }],
      deleteWorkspaceChatFileObjects: async () => {
        throw new WorkspaceDeletionRequiresSingleMemberError(2);
      },
      deleteWorkspace: async () => {
        deleteCalled = true;
        return { workspaceId: "workspace-1", name: "Shared" };
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(deleteCalled, false);
});

test("postDeleteWorkspaceRouteWithDeps keeps confirmation validation", async (): Promise<void> => {
  let deleteCalled = false;
  let chatFileCleanupCalled = false;
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Wrong"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-1", name: "Personal" }],
      deleteWorkspaceChatFileObjects: async () => {
        chatFileCleanupCalled = true;
      },
      deleteWorkspace: async () => {
        deleteCalled = true;
        return { workspaceId: "user-1", name: "Personal" };
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Confirmation text does not match workspace name");
  assert.equal(deleteCalled, false);
  assert.equal(chatFileCleanupCalled, false);
});

test("postDeleteWorkspaceRouteWithDeps allows single-member workspace deletion", async (): Promise<void> => {
  const calls: Array<string> = [];
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Project Alpha"),
    { params: Promise.resolve({ workspaceId: "workspace-a0f0f8e4" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-a0f0f8e4", name: "Project Alpha" }],
      deleteWorkspaceChatFileObjects: async (userId, workspaceId, targetWorkspaceId) => {
        calls.push(`chat-files:${userId}:${workspaceId}:${targetWorkspaceId}`);
      },
      deleteWorkspace: async () => {
        calls.push("workspace");
        return { workspaceId: "workspace-a0f0f8e4", name: "Project Alpha" };
      },
    },
  );

  assert.deepEqual(calls, [
    "chat-files:user-1:workspace-2:workspace-a0f0f8e4",
    "workspace",
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
