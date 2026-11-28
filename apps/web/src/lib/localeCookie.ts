import {
  APP_LOCALE_COOKIE,
  matchAcceptLanguage,
  parseSupportedLocale,
  type SupportedLocale,
} from "@expense-budget-tracker/agent-shared/locales";
import { headers } from "next/headers";

import { isDemoModeFromHeaders } from "@/lib/demoMode";

const DEMO_LOCALE_COOKIE = "demo_locale";
const LEGACY_LOCALE_COOKIE = "locale";
const LOCALE_COOKIE_ATTRIBUTES = "Path=/; Secure; SameSite=Lax; Max-Age=31536000";

const readLocaleCookie = (requestHeaders: Headers, name: string): SupportedLocale | null => {
  const cookies = requestHeaders.get("cookie")?.split(";") ?? [];
  if (name === LEGACY_LOCALE_COOKIE) cookies.reverse();
  for (const cookie of cookies) {
    const entry = cookie.trimStart();
    if (!entry.startsWith(`${name}=`)) continue;
    const locale = parseSupportedLocale(entry.slice(name.length + 1));
    if (locale !== null) return locale;
  }
  return null;
};

export const readAppLocaleCookie = (requestHeaders: Headers): SupportedLocale | null =>
  readLocaleCookie(requestHeaders, APP_LOCALE_COOKIE);

export const parseLocaleHint = (searchParams: URLSearchParams): SupportedLocale | null =>
  parseSupportedLocale(searchParams.get("locale"));

const isPublicShare = (pathname: string): boolean => pathname.startsWith("/share/monthly/");

const readDemoPageHint = (requestHeaders: Headers, requestUrl: URL): SupportedLocale | null => {
  if (!requestUrl.pathname.startsWith("/api/")) return null;
  const referer = URL.parse(requestHeaders.get("referer") ?? "");
  const origin = process.env.CORS_ORIGIN || requestUrl.origin;
  return referer?.origin === origin && !isPublicShare(referer.pathname)
    ? parseLocaleHint(referer.searchParams)
    : null;
};

export const getDemoLocalePreference = (requestHeaders: Headers): SupportedLocale =>
  readLocaleCookie(requestHeaders, DEMO_LOCALE_COOKIE)
  ?? readLocaleCookie(requestHeaders, LEGACY_LOCALE_COOKIE)
  ?? readAppLocaleCookie(requestHeaders)
  ?? matchAcceptLanguage(requestHeaders.get("accept-language"));

const localeFromHeaders = (requestHeaders: Headers, requestUrl: URL): SupportedLocale => {
  const hint = parseLocaleHint(requestUrl.searchParams);
  const publicShare = isPublicShare(requestUrl.pathname);
  if (!publicShare && isDemoModeFromHeaders(requestHeaders)) {
    return hint ?? readDemoPageHint(requestHeaders, requestUrl) ?? getDemoLocalePreference(requestHeaders);
  }

  const appLocale = readAppLocaleCookie(requestHeaders);
  const browserLocale = matchAcceptLanguage(requestHeaders.get("accept-language"));
  return publicShare
    ? hint ?? appLocale ?? readLocaleCookie(requestHeaders, LEGACY_LOCALE_COOKIE) ?? browserLocale
    : appLocale ?? hint ?? browserLocale;
};

const pathUrl = (path: string): URL => new URL(path, "https://app.invalid");

export const getLocaleCookie = async (): Promise<SupportedLocale> => {
  const requestHeaders = await headers();
  return localeFromHeaders(requestHeaders, pathUrl(requestHeaders.get("x-request-path") ?? "/"));
};

export const getLocaleFromRequest = (request: Request): SupportedLocale =>
  localeFromHeaders(request.headers, new URL(request.url));

export const getInitialLocale = (requestHeaders: Headers, returnTo: string): SupportedLocale =>
  parseLocaleHint(pathUrl(returnTo).searchParams)
  ?? readAppLocaleCookie(requestHeaders)
  ?? matchAcceptLanguage(requestHeaders.get("accept-language"));

export const getInitialLocaleCookie = async (): Promise<SupportedLocale> => {
  const requestHeaders = await headers();
  return getInitialLocale(requestHeaders, requestHeaders.get("x-request-path") ?? "/");
};

export const appLocaleSetCookie = (locale: SupportedLocale): string => {
  const domain = process.env.COOKIE_DOMAIN;
  const domainAttribute = domain === undefined || domain === "" ? "" : `; Domain=${domain}`;
  return `${APP_LOCALE_COOKIE}=${locale}; ${LOCALE_COOKIE_ATTRIBUTES}${domainAttribute}`;
};

export const demoLocaleSetCookie = (locale: SupportedLocale): string =>
  `${DEMO_LOCALE_COOKIE}=${locale}; ${LOCALE_COOKIE_ATTRIBUTES}`;
