import { getAdminConfig } from "@/server/config";

/**
 * The users every admin report counts: real accounts only, without the local
 * dev identity and without admins and other excluded emails. By convention `$1`
 * of every report statement is the `getExcludedEmails()` array.
 */
export const COUNTED_USERS_CTE = `counted_users AS (
  SELECT user_id, email, created_at, first_seen_at, last_seen_at
  FROM public.users
  WHERE user_id <> 'local'
    AND lower(email) <> ALL($1::text[])
)`;

export const getExcludedEmails = (): ReadonlyArray<string> => {
  const { adminEmails, analyticsExcludedEmails } = getAdminConfig();
  return [...new Set([...adminEmails, ...analyticsExcludedEmails])];
};
