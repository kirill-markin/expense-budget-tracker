import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { isPublicPath, proxy, resolveWorkspaceIdFromCookie } from "./proxy";

type EnvSnapshot = Readonly<{
  AUTH_MODE: string | undefined;
  AUTH_DOMAIN: string | undefined;
  CORS_ORIGIN: string | undefined;
  NODE_ENV: string | undefined;
}>;

const captureEnv = (): EnvSnapshot => ({
  AUTH_MODE: process.env.AUTH_MODE,
  AUTH_DOMAIN: process.env.AUTH_DOMAIN,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  NODE_ENV: process.env.NODE_ENV,
});

const restoreEnv = (snapshot: EnvSnapshot): void => {
  if (snapshot.AUTH_MODE === undefined) {
    delete process.env.AUTH_MODE;
  } else {
    process.env.AUTH_MODE = snapshot.AUTH_MODE;
  }
  if (snapshot.AUTH_DOMAIN === undefined) {
    delete process.env.AUTH_DOMAIN;
  } else {
    process.env.AUTH_DOMAIN = snapshot.AUTH_DOMAIN;
  }
  if (snapshot.CORS_ORIGIN === undefined) {
    delete process.env.CORS_ORIGIN;
  } else {
    process.env.CORS_ORIGIN = snapshot.CORS_ORIGIN;
  }
  if (snapshot.NODE_ENV === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    Reflect.set(process.env, "NODE_ENV", snapshot.NODE_ENV);
  }
};

const withCognitoEnv = async (run: () => Promise<void>): Promise<void> => {
  const snapshot = captureEnv();
  process.env.AUTH_MODE = "cognito";
  process.env.AUTH_DOMAIN = "auth.example.com";
  process.env.CORS_ORIGIN = "https://app.example.com";
  try {
    await run();
  } finally {
    restoreEnv(snapshot);
  }
};

const createRequest = (path: string): NextRequest =>
  new NextRequest(`https://app.example.com${path}`, { method: "GET" });

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
  assert.equal(isPublicPath("/share/monthly"), false);
  assert.equal(isPublicPath("/share/monthlytoken"), false);
  assert.equal(isPublicPath("/share/monthly/token/extra"), false);
  assert.equal(isPublicPath("/api/share/monthly"), false);
  assert.equal(isPublicPath("/share"), false);
  assert.equal(isPublicPath("/api/share/monthly-extra/token"), false);
  assert.equal(isPublicPath("/api/share/monthlyness/token"), false);
  assert.equal(isPublicPath("/api/share/monthly/token/extra"), false);
  assert.equal(isPublicPath("/api/share"), false);
  assert.equal(isPublicPath("/api/budget-grid"), false);
});

test("proxy allows public monthly share pages without auth cookies", async (): Promise<void> => {
  await withCognitoEnv(async (): Promise<void> => {
    const pageResponse = await proxy(createRequest("/share/monthly/public-token"));
    const apiResponse = await proxy(createRequest("/api/share/monthly/public-token?monthFrom=2025-01&monthTo=2025-12"));

    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get("location"), null);
    assert.equal(apiResponse.status, 200);
    assert.equal(apiResponse.headers.get("location"), null);
  });
});

test("proxy keeps unrelated app and API routes authenticated", async (): Promise<void> => {
  await withCognitoEnv(async (): Promise<void> => {
    const appResponse = await proxy(createRequest("/transactions"));
    const apiResponse = await proxy(createRequest("/api/budget-grid"));

    assert.equal(appResponse.status, 307);
    assert.match(appResponse.headers.get("location") ?? "", /^https:\/\/auth\.example\.com\/login/u);
    assert.equal(apiResponse.status, 307);
    assert.match(apiResponse.headers.get("location") ?? "", /^https:\/\/auth\.example\.com\/login/u);
  });
});

test("production CSP allows only same-origin and blob workers", async (): Promise<void> => {
  await withCognitoEnv(async (): Promise<void> => {
    Reflect.set(process.env, "NODE_ENV", "production");
    const response = await proxy(createRequest("/api/health"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    assert.match(csp, /(?:^|; )worker-src 'self' blob:(?:;|$)/u);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/u);
  });
});
