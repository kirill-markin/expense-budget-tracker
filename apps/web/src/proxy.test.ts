import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceIdFromCookie } from "./proxy";

const VALID_WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

test("resolveWorkspaceIdFromCookie prefers a valid workspace cookie", () => {
  assert.equal(
    resolveWorkspaceIdFromCookie(VALID_WORKSPACE_ID, "user-1"),
    VALID_WORKSPACE_ID,
  );
});

test("resolveWorkspaceIdFromCookie falls back to the personal workspace when cookie is missing", () => {
  assert.equal(resolveWorkspaceIdFromCookie(undefined, "user-1"), "user-1");
});

test("resolveWorkspaceIdFromCookie falls back to the personal workspace when cookie is invalid", () => {
  assert.equal(resolveWorkspaceIdFromCookie("not-a-workspace", "user-1"), "user-1");
});
