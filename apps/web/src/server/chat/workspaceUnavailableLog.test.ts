import assert from "node:assert/strict";
import test from "node:test";
import { createChatWorkspaceUnavailableLogEvent } from "@/server/chat/workspaceUnavailableLog";
import { WorkspaceAccessError } from "@/server/workspaceErrors";

/** A tool can target a workspace other than the session's; the event must name the target. */
test("createChatWorkspaceUnavailableLogEvent takes the user and workspace from the error", (): void => {
  const error = new WorkspaceAccessError("user-1", "workspace-target");

  assert.deepEqual(createChatWorkspaceUnavailableLogEvent(
    { requestId: "req-1", sessionId: "session-1" },
    "agent",
    error,
  ), {
    domain: "chat",
    action: "workspace_unavailable",
    vendor: "openai",
    stage: "agent",
    error: "User user-1 is not a member of workspace workspace-target",
    requestId: "req-1",
    userId: "user-1",
    workspaceId: "workspace-target",
    sessionId: "session-1",
  });
});
