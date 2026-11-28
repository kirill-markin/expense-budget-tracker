import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createLoginPageApp } from "./loginPage.js";

const appOrigin = "https://app.example.com";
const adminOrigin = "https://admin.example.com";
const oauthIssuer = "https://auth.example.com";

const configureRedirects = (t: TestContext): void => {
  const previousAllowed = process.env.ALLOWED_REDIRECT_URIS;
  const previousIssuer = process.env.OAUTH_ISSUER;
  process.env.ALLOWED_REDIRECT_URIS = `${appOrigin},${adminOrigin}`;
  process.env.OAUTH_ISSUER = oauthIssuer;
  t.after(() => {
    if (previousAllowed === undefined) delete process.env.ALLOWED_REDIRECT_URIS;
    else process.env.ALLOWED_REDIRECT_URIS = previousAllowed;
    if (previousIssuer === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = previousIssuer;
  });
};

const loginPath = (redirectUri: string): string => `/login?redirect_uri=${encodeURIComponent(redirectUri)}`;

const readContinuation = (html: string): string => {
  const encoded = /var redirectUri = ("[^\n]*");/u.exec(html)?.[1];
  assert.ok(encoded);
  return JSON.parse(encoded) as string;
};

test("login keeps each tab's selected locale in its app continuation", async (t): Promise<void> => {
  configureRedirects(t);
  const app = createLoginPageApp({ resolveBrowserSession: async () => null });
  const login = loginPath(`${appOrigin}/budget?month=2026-04&locale=he#spending`);
  const headers = { cookie: "locale=es; locale=ru; app_locale=uk; auth_locale=ar", "accept-language": "es" };
  const [first, second] = await Promise.all([
    app.request(`${login}&lang=ZH-hans`, { headers }),
    app.request(`${login}&lang=fa`, { headers }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.headers.getSetCookie(), []);
  assert.deepEqual(second.headers.getSetCookie(), []);
  const firstHtml = await first.text();
  assert.match(firstHtml, /<html lang="zh-Hans" dir="ltr">/u);
  assert.equal(readContinuation(firstHtml), `${appOrigin}/budget?month=2026-04&locale=zh-Hans#spending`);
  assert.equal(readContinuation(await second.text()), `${appOrigin}/budget?month=2026-04&locale=fa#spending`);

  const unhintedAppLogin = `${loginPath(`${appOrigin}/budget`)}&carry_locale=1`;
  const later = await app.request(unhintedAppLogin, {
    headers: { cookie: "locale=he", "accept-language": "es" },
  });
  assert.deepEqual(later.headers.getSetCookie(), []);
  assert.equal(readContinuation(await later.text()), `${appOrigin}/budget?locale=es`);

  const remembered = await app.request(unhintedAppLogin, {
    headers: { cookie: "auth_locale=ru; locale=he", "accept-language": "es" },
  });
  assert.equal(readContinuation(await remembered.text()), `${appOrigin}/budget?locale=ru`);

  const account = await app.request(unhintedAppLogin, {
    headers: { cookie: "app_locale=uk; auth_locale=ru", "accept-language": "es" },
  });
  assert.equal(readContinuation(await account.text()), `${appOrigin}/budget?locale=uk`);
});

test("login keeps the validated OAuth continuation byte-for-byte", async (t): Promise<void> => {
  configureRedirects(t);
  const app = createLoginPageApp({ resolveBrowserSession: async () => null });
  const oauthReturn = `${oauthIssuer}/oauth/authorize?client_id=client-1&state=a%2bb%20c&locale=ar`;
  const login = await app.request(`${loginPath(oauthReturn)}&lang=he&carry_locale=1`);
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /<html lang="he" dir="rtl">/u);
  assert.equal(readContinuation(html), oauthReturn);
  assert.deepEqual(login.headers.getSetCookie(), []);
  assert.match(html, /document\.cookie = "auth_locale=" \+ encodeURIComponent\(this\.value\) \+ "; Path=\/; Max-Age=31536000; Secure; SameSite=Lax";/u);

  const remembered = await app.request(loginPath(oauthReturn), {
    headers: { cookie: "auth_locale=he; app_locale=ru; locale=ar", "accept-language": "en" },
  });
  assert.equal(remembered.status, 200);
  const rememberedHtml = await remembered.text();
  assert.match(rememberedHtml, /<html lang="he" dir="rtl">/u);
  assert.equal(readContinuation(rememberedHtml), oauthReturn);

  const adminReturn = `${adminOrigin}/reports?search=some%20text`;
  const admin = await app.request(loginPath(adminReturn), { headers: { "accept-language": "he" } });
  assert.equal(admin.status, 200);
  const adminHtml = await admin.text();
  assert.match(adminHtml, /<html lang="he" dir="rtl">/u);
  assert.equal(readContinuation(adminHtml), adminReturn);

  const external = await app.request(`${loginPath("https://app.example.com.other/budget")}&lang=he`);
  assert.equal(external.status, 400);
});
