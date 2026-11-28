/**
 * Login page route. Validates redirect_uri origin against ALLOWED_REDIRECT_URIS,
 * parses Accept-Language for locale, and serves the HTML login page.
 *
 * The redirect_uri may include a path (e.g. https://app.example.com/budget)
 * so the user returns to the page they originally visited after login.
 * Only the origin is validated against ALLOWED_REDIRECT_URIS.
 */
import { Hono } from "hono";
import {
  getRawQueryByteLength,
  MAX_OAUTH_LOGIN_QUERY_BYTES,
} from "@expense-budget-tracker/agent-shared";
import { matchAcceptLanguage, parseSupportedLocale } from "@expense-budget-tracker/agent-shared/locales";
import { setCookie } from "hono/cookie";
import { renderLoginPage } from "../templates/login.js";
import { resolveBrowserSession } from "../server/oauth/session.js";

export type LoginPageDependencies = Readonly<{
  resolveBrowserSession: typeof resolveBrowserSession;
}>;

const defaultDependencies: LoginPageDependencies = {
  resolveBrowserSession,
};

const getAllowedOrigins = (): ReadonlyArray<string> => {
  const raw = process.env.ALLOWED_REDIRECT_URIS ?? "";
  const configured = raw === "" ? [] : raw.split(",");
  const oauthIssuer = process.env.OAUTH_ISSUER ?? "";
  return [...configured, ...(oauthIssuer === "" ? [] : [oauthIssuer])].map((u) => {
    try {
      return new URL(u.trim()).origin;
    } catch {
      return u.trim();
    }
  });
};

const isAllowedRedirectUri = (uri: string): boolean => {
  try {
    const origin = new URL(uri).origin;
    return getAllowedOrigins().includes(origin);
  } catch {
    return false;
  }
};

export const createLoginPageApp = (dependencies: LoginPageDependencies): Hono => {
  const app = new Hono();

  app.get("/login", async (c) => {
    if (getRawQueryByteLength(c.req.url) > MAX_OAUTH_LOGIN_QUERY_BYTES) {
      return c.text(`Login query must not exceed ${MAX_OAUTH_LOGIN_QUERY_BYTES} UTF-8 bytes`, 400);
    }
    const redirectUri = c.req.query("redirect_uri") ?? "";

    if (redirectUri === "") {
      return c.text("Missing redirect_uri parameter", 400);
    }

    if (!isAllowedRedirectUri(redirectUri)) {
      return c.text("Invalid redirect_uri", 400);
    }

    const identity = await dependencies.resolveBrowserSession(c);
    if (identity !== null) return c.redirect(redirectUri, 302);

    const locale = parseSupportedLocale(c.req.query("lang"))
      ?? matchAcceptLanguage(c.req.header("accept-language"));

    const domain = process.env.COOKIE_DOMAIN ?? "";
    const websiteUrl = domain.startsWith(".")
      ? `https://${domain.slice(1)}`
      : `https://${domain}`;
    const html = renderLoginPage(locale, redirectUri, websiteUrl, domain);

    setCookie(c, "locale", locale, {
      domain: domain === "" ? undefined : domain,
      path: "/",
      maxAge: 31536000,
      secure: true,
      sameSite: "Lax",
    });
    return c.html(html);
  });

  return app;
};

export default createLoginPageApp(defaultDependencies);
