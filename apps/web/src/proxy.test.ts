import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceIdFromCookie } from "./proxy";

test("resolveWorkspaceIdFromCookie returns null for missing cookie values", (): void => {
  assert.equal(resolveWorkspaceIdFromCookie(undefined), null);
  assert.equal(resolveWorkspaceIdFromCookie(""), null);
  assert.equal(resolveWorkspaceIdFromCookie("user-1"), null);
});

test("resolveWorkspaceIdFromCookie keeps UUID workspace cookies", (): void => {
  assert.equal(
    resolveWorkspaceIdFromCookie("3c90f5bd-8505-40ae-8d7f-a9f00f4b8fb6"),
    "3c90f5bd-8505-40ae-8d7f-a9f00f4b8fb6",
  );
});
