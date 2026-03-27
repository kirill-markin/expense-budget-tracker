import { cookies } from "next/headers";

import { BROWSER_TIMEZONE_COOKIE, parseTimezone } from "@/lib/timezone";

export const getBrowserTimezoneCookie = async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const rawTimezone = cookieStore.get(BROWSER_TIMEZONE_COOKIE)?.value ?? "";
  return parseTimezone(rawTimezone);
};
