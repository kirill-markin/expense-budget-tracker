/**
 * Account-state vocabulary stored in `users.cognito_status`.
 *
 * The column name is historical: it also stores statuses no Cognito user pool
 * produces. Every surface that decides whether an account may act — the web
 * app mirror, the MCP access-token gate and the OAuth owner check in the auth
 * service — reads these values from here, so renaming one cannot leave one app
 * admitting an identity another one denies.
 */

/** Identity confirmed by the Cognito user pool. */
export const COGNITO_AUTHENTICATED_STATUS = "CONFIRMED";

/** Identity asserted by the upstream proxy when the deployment runs AUTH_MODE=proxy_jwt. */
export const PROXY_AUTHENTICATED_STATUS = "PROXY";

/**
 * `users.cognito_status` values that mean the account is currently active.
 *
 * Membership is exact, so every other status denies access, and
 * `cognito_enabled` stays the per-request revocation lever for every provider.
 */
const ACTIVE_USER_STATUSES: ReadonlySet<string> = new Set([
  COGNITO_AUTHENTICATED_STATUS,
  PROXY_AUTHENTICATED_STATUS,
]);

export const isActiveUserStatus = (status: string): boolean => ACTIVE_USER_STATUSES.has(status);
