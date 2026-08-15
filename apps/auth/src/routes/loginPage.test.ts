import assert from "node:assert/strict";
import test from "node:test";
import { MAX_OAUTH_LOGIN_QUERY_BYTES } from "@expense-budget-tracker/agent-shared";
import { createLoginPageApp } from "./loginPage.js";
import { clearBrowserSessionCookies } from "../server/oauth/session.js";

test("login clears an invalid non-empty session instead of redirecting in a loop", async (): Promise<void> => {
  const previousAllowedRedirects = process.env.ALLOWED_REDIRECT_URIS;
  const previousIssuer = process.env.OAUTH_ISSUER;
  const previousCookieDomain = process.env.COOKIE_DOMAIN;
  process.env.ALLOWED_REDIRECT_URIS = "https://app.example.com";
  process.env.OAUTH_ISSUER = "https://auth.example.com";
  process.env.COOKIE_DOMAIN = ".example.com";
  const app = createLoginPageApp({
    resolveBrowserSession: async (c) => {
      clearBrowserSessionCookies(c);
      return null;
    },
  });

  try {
    const redirectUri = "https://auth.example.com/oauth/authorize?client_id=client-1";
    const response = await app.request(`/login?redirect_uri=${encodeURIComponent(redirectUri)}`, {
      headers: { Cookie: "session=expired-session" },
    });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().join("\n");
    assert.match(cookies, /session=;/u);
    assert.match(cookies, /refresh=;/u);
    assert.match(cookies, /logged_in=;/u);
    assert.match(cookies, /locale=en/u);

    const fixedQuery = `redirect_uri=${encodeURIComponent(redirectUri)}&padding=`;
    const exactQuery = `${fixedQuery}${"x".repeat(MAX_OAUTH_LOGIN_QUERY_BYTES - fixedQuery.length)}`;
    const exactBoundary = await app.request(`/login?${exactQuery}`);
    assert.equal(exactBoundary.status, 200);

    const oversized = await app.request(`/login?${exactQuery}x`);
    assert.equal(oversized.status, 400);
    assert.equal(
      await oversized.text(),
      `Login query must not exceed ${MAX_OAUTH_LOGIN_QUERY_BYTES} UTF-8 bytes`,
    );
  } finally {
    if (previousAllowedRedirects === undefined) delete process.env.ALLOWED_REDIRECT_URIS;
    else process.env.ALLOWED_REDIRECT_URIS = previousAllowedRedirects;
    if (previousIssuer === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = previousIssuer;
    if (previousCookieDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = previousCookieDomain;
  }
});
