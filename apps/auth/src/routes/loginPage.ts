/**
 * Login page route. Validates redirect_uri origin against ALLOWED_REDIRECT_URIS,
 * parses Accept-Language for locale, and serves the HTML login page.
 *
 * The redirect_uri may include a path (e.g. https://app.example.com/budget)
 * so the user returns to the page they originally visited after login.
 * Only the origin is validated against ALLOWED_REDIRECT_URIS.
 */
import { Hono } from "hono";
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

  const locale = parseLocale(c.req.header("accept-language") ?? null);
  const html = renderLoginPage(locale, redirectUri);

  return c.html(html);
});

export default app;
