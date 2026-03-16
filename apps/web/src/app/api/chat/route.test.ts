import assert from "node:assert/strict";
import test from "node:test";

import { extractChatRequestContext } from "./route";

test("extractChatRequestContext reads user and workspace IDs from trusted headers", () => {
  const request = new Request("https://app.example.com/api/chat", {
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  assert.deepEqual(extractChatRequestContext(request), {
    userId: "user-1",
    workspaceId: "workspace-1",
  });
});

test("extractChatRequestContext rejects requests without a workspace header", () => {
  const request = new Request("https://app.example.com/api/chat", {
    headers: {
      "x-user-id": "user-1",
    },
  });

  assert.throws(
    () => extractChatRequestContext(request),
    /Missing x-workspace-id header/,
  );
});
