import { cookies } from "next/headers";

import { DEMO_MODE_COOKIE } from "@/lib/demoCookies";

/** Check if demo mode is active (cookie). For Server Components. */
export const isDemoMode = async (): Promise<boolean> => {
  const cookieStore = await cookies();
  return cookieStore.get(DEMO_MODE_COOKIE)?.value === "true";
};

/** Check if demo mode is active from a raw Request. For API route handlers. */
export const isDemoModeFromRequest = (request: Request): boolean => {
  const cookieHeader = request.headers.get("cookie") ?? "";
  return cookieHeader.split(";").some((c) => c.trim() === `${DEMO_MODE_COOKIE}=true`);
};
