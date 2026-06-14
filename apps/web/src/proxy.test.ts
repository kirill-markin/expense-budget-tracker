import assert from "node:assert/strict";
import test from "node:test";
import { isPublicPath, resolveWorkspaceIdFromCookie } from "./proxy";

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

test("isPublicPath keeps exact public paths public", (): void => {
  const publicPaths: ReadonlyArray<string> = [
    "/api/auth/logout",
    "/api/agent",
    "/api/live",
    "/api/health",
    "/.well-known/agent.json",
  ];

  for (const pathname of publicPaths) {
    assert.equal(isPublicPath(pathname), true);
  }
});

test("isPublicPath allows only narrow public share prefixes", (): void => {
  assert.equal(isPublicPath("/share/monthly/token"), true);
  assert.equal(isPublicPath("/api/share/monthly/token"), true);
  assert.equal(isPublicPath("/share"), false);
  assert.equal(isPublicPath("/api/share/monthly-extra/token"), false);
  assert.equal(isPublicPath("/api/share"), false);
  assert.equal(isPublicPath("/api/budget-grid"), false);
});
