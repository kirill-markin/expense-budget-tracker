/**
 * Login page route. Validates redirect_uri origin against ALLOWED_REDIRECT_URIS,
 * parses Accept-Language for locale, and serves the HTML login page.
 *
 * The redirect_uri may include a path (e.g. https://app.example.com/budget)
 * so the user returns to the page they originally visited after login.
 * Only the origin is validated against ALLOWED_REDIRECT_URIS.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { renderLoginPage } from "../templates/login.js";

const app = new Hono();

const getAllowedOrigins = (): ReadonlyArray<string> => {
  const raw = process.env.ALLOWED_REDIRECT_URIS ?? "";
  if (raw === "") return [];
  return raw.split(",").map((u) => {
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

const SUPPORTED_LOCALES = ["en", "es", "zh", "ru", "uk", "fa", "ar", "he"] as const;
type Locale = typeof SUPPORTED_LOCALES[number];

const parseLocale = (acceptLanguage: string | null): Locale => {
  if (acceptLanguage === null) return "en";
  const tags = acceptLanguage.split(",").map((tag) => {
    const [lang, q] = tag.trim().split(";q=");
    return { lang: lang.trim().split("-")[0].toLowerCase(), q: q !== undefined ? parseFloat(q) : 1.0 };
  });
  tags.sort((a, b) => b.q - a.q);
  for (const tag of tags) {
    const match = SUPPORTED_LOCALES.find((l) => l === tag.lang);
    if (match !== undefined) return match;
  }
  return "en";
};

app.get("/login", (c) => {
  const redirectUri = c.req.query("redirect_uri") ?? "";

  if (redirectUri === "") {
    return c.text("Missing redirect_uri parameter", 400);
  }

  if (!isAllowedRedirectUri(redirectUri)) {
    return c.text("Invalid redirect_uri", 400);
  }

  // If the user already has a session, skip the login form and redirect.
  // Real JWT verification happens on app.* — if the session is expired,
  // the proxy refreshes it or clears cookies and sends the user back here.
  const sessionCookie = getCookie(c, "session") ?? "";
  if (sessionCookie !== "") {
    return c.redirect(redirectUri, 302);
  }

  const langParam = c.req.query("lang") ?? "";
  const locale: Locale = (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(langParam)
    ? (langParam as Locale)
    : parseLocale(c.req.header("accept-language") ?? null);

  const domain = process.env.COOKIE_DOMAIN ?? "";
  const websiteUrl = domain.startsWith(".")
    ? `https://${domain.slice(1)}`
    : `https://${domain}`;
  const html = renderLoginPage(locale, redirectUri, websiteUrl);

  c.header("Set-Cookie", `locale=${locale}; Domain=${domain}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`);
  return c.html(html);
});

export default app;
