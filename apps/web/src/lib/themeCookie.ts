import { cookies } from "next/headers";

import { type ThemePreference, parseThemePreference } from "@/lib/theme";

const THEME_COOKIE = "theme";

/** Read the theme preference from cookie. For Server Components. */
export const getThemeCookie = async (): Promise<ThemePreference> => {
  const cookieStore = await cookies();
  return parseThemePreference(cookieStore.get(THEME_COOKIE)?.value ?? null);
};

/** Read the theme preference from a raw Request. For API route handlers. */
export const getThemeFromRequest = (request: Request): ThemePreference => {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)theme=([^;]*)/);
  return parseThemePreference(match !== null ? decodeURIComponent(match[1]) : null);
};
