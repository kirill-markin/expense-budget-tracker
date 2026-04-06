import assert from "node:assert/strict";
import test from "node:test";
import { postDeleteWorkspaceRouteWithDeps } from "@/app/api/workspaces/[workspaceId]/delete/route";
import { SharedWorkspaceDeletionDisabledError } from "@/server/workspaces";

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

test("postDeleteWorkspaceRouteWithDeps returns 403 for shared workspace deletion", async (): Promise<void> => {
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Shared"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-1", name: "Shared" }],
      deleteWorkspace: async () => {
        throw new SharedWorkspaceDeletionDisabledError();
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Shared workspace deletion is disabled until workspace admin roles are introduced");
});

test("postDeleteWorkspaceRouteWithDeps keeps confirmation validation", async (): Promise<void> => {
  let deleteCalled = false;
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Wrong"),
    { params: Promise.resolve({ workspaceId: "workspace-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "workspace-1", name: "Personal" }],
      deleteWorkspace: async () => {
        deleteCalled = true;
        return { workspaceId: "user-1", name: "Personal" };
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Confirmation text does not match workspace name");
  assert.equal(deleteCalled, false);
});

test("postDeleteWorkspaceRouteWithDeps allows personal workspace deletion", async (): Promise<void> => {
  const response = await postDeleteWorkspaceRouteWithDeps(
    createRequest("Personal"),
    { params: Promise.resolve({ workspaceId: "user-1" }) },
    {
      listWorkspaces: async () => [{ workspaceId: "user-1", name: "Personal" }],
      deleteWorkspace: async () => ({ workspaceId: "user-1", name: "Personal" }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
