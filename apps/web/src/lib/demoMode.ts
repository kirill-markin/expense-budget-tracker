import { cookies } from "next/headers";

import { DEMO_MODE_COOKIE } from "@/lib/demoCookies";

/** Check if demo mode is active (cookie). For Server Components. */
export const isDemoMode = async (): Promise<boolean> => {
  const cookieStore = await cookies();
  return cookieStore.get(DEMO_MODE_COOKIE)?.value === "true";
};

export const isDemoModeFromHeaders = (requestHeaders: Headers): boolean =>
  (requestHeaders.get("cookie")?.split(";") ?? []).some((cookie) => cookie.trim() === `${DEMO_MODE_COOKIE}=true`);

export const isDemoModeFromRequest = (request: Request): boolean => isDemoModeFromHeaders(request.headers);
