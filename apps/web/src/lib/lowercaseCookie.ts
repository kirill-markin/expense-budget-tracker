import { cookies } from "next/headers";

/** The account is authoritative; this cookie carries the preference in demo mode. */
export const getLowercaseCookie = async (): Promise<boolean> =>
  (await cookies()).get("lowercase")?.value === "true";

export const getLowercaseFromRequest = (request: Request): boolean =>
  /(?:^|;\s*)lowercase=true(?:;|$)/.test(request.headers.get("cookie") ?? "");
