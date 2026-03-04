import { cookies } from "next/headers";

import { type SupportedLocale, resolveLocale } from "@/lib/locale";

const LOCALE_COOKIE = "locale";

/** Read locale from cookie. For Server Components. */
export const getLocaleCookie = async (): Promise<SupportedLocale> => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value ?? "en";
  return resolveLocale(raw);
};

/** Read locale from a raw Request. For API route handlers. */
export const getLocaleFromRequest = (request: Request): SupportedLocale => {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)locale=([^;]*)/);
  const raw = match !== null ? decodeURIComponent(match[1]) : "en";
  return resolveLocale(raw);
};
