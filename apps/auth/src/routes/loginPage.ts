/**
 * Login page route. Validates redirect_uri origin against ALLOWED_REDIRECT_URIS,
 * negotiates locale, and serves the HTML login page.
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
import {
  APP_LOCALE_COOKIE,
  AUTH_LOCALE_COOKIE,
  CARRY_LOCALE_QUERY_PARAM,
  LOCALE_REGISTRY,
  matchAcceptLanguage,
  parseSupportedLocale,
} from "@expense-budget-tracker/agent-shared/locales";
import { getCookie } from "hono/cookie";
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

const isBrowserContinuation = (url: URL): boolean =>
  (url.protocol === "https:" || url.protocol === "http:")
  && url.origin !== URL.parse(process.env.OAUTH_ISSUER ?? "")?.origin;

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

    const returnUrl = URL.parse(redirectUri);
    if (returnUrl === null || !getAllowedOrigins().includes(returnUrl.origin)) {
      return c.text("Invalid redirect_uri", 400);
    }

    const browserContinuation = isBrowserContinuation(returnUrl);
    const continuationLocale = browserContinuation ? parseSupportedLocale(returnUrl.searchParams.get("locale")) : null;
    const requestedLocale = parseSupportedLocale(c.req.query("lang"));
    const carryLocale = browserContinuation
      && (requestedLocale !== null || continuationLocale !== null || c.req.query(CARRY_LOCALE_QUERY_PARAM) === "1");
    const appLocale = parseSupportedLocale(getCookie(c, APP_LOCALE_COOKIE));
    const authLocale = parseSupportedLocale(getCookie(c, AUTH_LOCALE_COOKIE));
    const savedLocale = browserContinuation ? appLocale ?? authLocale : authLocale ?? appLocale;
    const locale = requestedLocale ?? continuationLocale ?? savedLocale ?? matchAcceptLanguage(c.req.header("accept-language"));

    // The OAuth authorize continuation carries the original client's parameters.
    let continuation = redirectUri;
    if (carryLocale && continuationLocale !== locale) {
      returnUrl.searchParams.set("locale", LOCALE_REGISTRY[locale].tag);
      continuation = returnUrl.toString();
    }

    const identity = await dependencies.resolveBrowserSession(c);
    if (identity !== null) return c.redirect(continuation, 302);

    const domain = process.env.COOKIE_DOMAIN ?? "";
    const websiteUrl = domain.startsWith(".")
      ? `https://${domain.slice(1)}`
      : `https://${domain}`;
    return c.html(renderLoginPage(locale, continuation, websiteUrl, domain));
  });

  return app;
};

export default createLoginPageApp(defaultDependencies);
