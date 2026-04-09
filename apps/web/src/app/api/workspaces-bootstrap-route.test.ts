import assert from "node:assert/strict";
import test from "node:test";
import { getWorkspaceBootstrapRouteWithDeps } from "./workspaces/bootstrap/route";

const createRequest = (returnTo: string): Request =>
  new Request(`http://localhost/api/workspaces/bootstrap?returnTo=${encodeURIComponent(returnTo)}`, {
    method: "GET",
    headers: {
      "x-user-id": "user-1",
      "x-user-email": "user@example.com",
      "x-user-email-verified": "true",
    },
  });

test("getWorkspaceBootstrapRouteWithDeps sets workspace cookie and redirects to requested path", async (): Promise<void> => {
  const response = await getWorkspaceBootstrapRouteWithDeps(
    createRequest("/balances?month=2026-04"),
    {
      resolveWorkspaceForIdentity: async () => ({
        workspaceId: "workspace-1",
        name: "Main",
        created: false,
        requestedWorkspaceAccessible: false,
      }),
    },
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/balances?month=2026-04");
  const setCookie = response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /workspace=workspace-1/);
});

test("getWorkspaceBootstrapRouteWithDeps falls back to root for invalid returnTo", async (): Promise<void> => {
  const response = await getWorkspaceBootstrapRouteWithDeps(
    createRequest("https://evil.example.com"),
    {
      resolveWorkspaceForIdentity: async () => ({
        workspaceId: "workspace-1",
        name: "Main",
        created: false,
        requestedWorkspaceAccessible: false,
      }),
    },
  );

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/");
});
