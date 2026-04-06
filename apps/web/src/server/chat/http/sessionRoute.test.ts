import assert from "node:assert/strict";
import test from "node:test";
import { createChatSessionRouteWithDeps } from "@/server/chat/http/sessionRoute";

const createHeaders = (): Headers =>
  new Headers({
    "x-user-id": "user-1",
    "x-workspace-id": "workspace-1",
  });

test("createChatSessionRouteWithDeps returns a fresh session id", async (): Promise<void> => {
  const response = await createChatSessionRouteWithDeps(
    new Request("http://localhost/api/chat/session", {
      method: "POST",
      headers: createHeaders(),
    }),
    {
      createFreshChatSession: async (userId, workspaceId) => {
        assert.equal(userId, "user-1");
        assert.equal(workspaceId, "workspace-1");
        return "session-1";
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId: "session-1" });
});
