import type { JsonObject } from "aws-jwt-verify/safe-json-parse";

export type AdminAccessDecision = "allowed" | "redirect_to_login" | "forbidden";

export type AdminAccessConfig = Readonly<{ adminEmails: ReadonlyArray<string> }>;

/**
 * `claims` is the verified ID token payload, or null when there is no valid session.
 * The email must equal an admin entry exactly, case included: the user pool is
 * case-sensitive, so a case variant is a different account.
 */
export const decideAdminAccess = (
  claims: JsonObject | null,
  config: AdminAccessConfig,
): AdminAccessDecision => {
  if (claims === null) return "redirect_to_login";
  const email = claims.email;
  if (claims.email_verified !== true || typeof email !== "string") return "forbidden";
  return config.adminEmails.includes(email) ? "allowed" : "forbidden";
};
