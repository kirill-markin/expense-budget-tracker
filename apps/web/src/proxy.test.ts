import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { PROXY_JWT_UNAUTHORIZED_MESSAGE } from "@expense-budget-tracker/agent-shared/proxy-jwt";
import { isPublicPath, proxy, resolveWorkspaceIdFromCookie } from "./proxy";

const MANAGED_ENV_KEYS = [
  "AUTH_MODE",
  "AUTH_DOMAIN",
  "CORS_ORIGIN",
  "NODE_ENV",
  "AUTH_PROXY_JWT_HEADER",
  "AUTH_PROXY_JWKS_URL",
  "AUTH_PROXY_JWT_ISSUER",
  "AUTH_PROXY_JWT_AUDIENCE",
] as const;

type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];
type EnvSnapshot = Readonly<Partial<Record<ManagedEnvKey, string>>>;

const captureEnv = (): EnvSnapshot =>
  Object.fromEntries(
    MANAGED_ENV_KEYS.map((key: ManagedEnvKey): [ManagedEnvKey, string | undefined] => [key, process.env[key]]),
  ) as EnvSnapshot;

const applyEnv = (values: EnvSnapshot): void => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      Reflect.set(process.env, key, value);
    }
  }
};

const withEnv = async (values: EnvSnapshot, run: () => Promise<void>): Promise<void> => {
  const snapshot = captureEnv();
  for (const [key, value] of Object.entries(values)) {
    Reflect.set(process.env, key, value);
  }
  try {
    await run();
  } finally {
    applyEnv(snapshot);
  }
};

const COGNITO_ENV: EnvSnapshot = {
  AUTH_MODE: "cognito",
  AUTH_DOMAIN: "auth.example.com",
  CORS_ORIGIN: "https://app.example.com",
};

const PROXY_JWT_HEADER = "cf-access-jwt-assertion";

const PROXY_JWT_ENV: EnvSnapshot = {
  AUTH_MODE: "proxy_jwt",
  CORS_ORIGIN: "https://app.example.com",
  AUTH_PROXY_JWT_HEADER: PROXY_JWT_HEADER,
  AUTH_PROXY_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  AUTH_PROXY_JWT_ISSUER: "https://team.cloudflareaccess.com",
  AUTH_PROXY_JWT_AUDIENCE: "application-audience-tag",
};

const withCognitoEnv = async (run: () => Promise<void>): Promise<void> => withEnv(COGNITO_ENV, run);

const withProxyJwtEnv = async (run: () => Promise<void>): Promise<void> => withEnv(PROXY_JWT_ENV, run);

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

test("proxy_jwt answers a request without a proxy token with 401 and no redirect", async (): Promise<void> => {
  await withProxyJwtEnv(async (): Promise<void> => {
    const response = await proxy(createRequest("/transactions"));

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
    assert.equal(await response.text(), PROXY_JWT_UNAUTHORIZED_MESSAGE);
  });
});

test("proxy_jwt rejects a token it cannot verify", async (): Promise<void> => {
  await withProxyJwtEnv(async (): Promise<void> => {
    const request = new NextRequest("https://app.example.com/api/budget-grid", {
      method: "GET",
      headers: { [PROXY_JWT_HEADER]: "not-a-jwt" },
    });

    const response = await proxy(request);

    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null);
  });
});

test("proxy_jwt keeps public paths and the ApiKey agent surface exempt", async (): Promise<void> => {
  await withProxyJwtEnv(async (): Promise<void> => {
    const publicResponse = await proxy(createRequest("/share/monthly/public-token"));
    assert.equal(publicResponse.status, 200);

    const agentRequest = new NextRequest("https://app.example.com/api/agent/sql", {
      method: "GET",
      headers: { authorization: "ApiKey ebt_live_example" },
    });
    const agentResponse = await proxy(agentRequest);
    assert.equal(agentResponse.status, 200);
    assert.equal(agentResponse.headers.get("location"), null);
  });
});

test("proxy_jwt still fails CSRF validation before authenticating a mutating request", async (): Promise<void> => {
  await withProxyJwtEnv(async (): Promise<void> => {
    const request = new NextRequest("https://app.example.com/api/transactions", {
      method: "POST",
      headers: { [PROXY_JWT_HEADER]: "not-a-jwt", "x-user-id": "injected-user" },
    });

    const response = await proxy(request);

    assert.equal(response.status, 403);
    assert.equal(await response.text(), "CSRF validation failed");
  });
});

test("a proxy-shaped request is still redirected to login while AUTH_MODE=cognito", async (): Promise<void> => {
  await withCognitoEnv(async (): Promise<void> => {
    const request = new NextRequest("https://app.example.com/transactions", {
      method: "GET",
      headers: { [PROXY_JWT_HEADER]: "any-token" },
    });

    const response = await proxy(request);

    assert.equal(response.status, 307);
    assert.match(response.headers.get("location") ?? "", /^https:\/\/auth\.example\.com\/login/u);
  });
});
