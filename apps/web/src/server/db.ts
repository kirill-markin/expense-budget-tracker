/**
 * Postgres connection pool and query helpers.
 *
 * query()           — bare pool.query, no RLS context. Used only for global
 *                     tables (fx_rates_raw, fx_rates_daily) and readiness checks.
 * queryAs()         — single statement in a transaction with app.user_id and
 *                     app.workspace_id set.
 * withUserContext() — multiple statements in one transaction with app.user_id
 *                     and app.workspace_id. The callback receives a bound
 *                     queryFn sharing one client.
 * withRestrictedUserContext() — same as withUserContext(), but user SQL runs
 *                     as api_sql_executor after the RLS context is set.
 */
import { createDbFacade } from "@/server/db/facade";
import { getPool as getBasePool, query as queryBase } from "@/server/db/pool";
import {
  ensureTrustedIdentityProvisioned as ensureTrustedIdentityProvisionedBase,
  ensureUserProvisioned as ensureUserProvisionedBase,
} from "@/server/db/provisioning";

const facade = createDbFacade({
  query: queryBase,
  getPool: getBasePool,
  ensureUserProvisioned: ensureUserProvisionedBase,
  ensureTrustedIdentityProvisioned: ensureTrustedIdentityProvisionedBase,
});

export const query = facade.query;
export const getPool = facade.getPool;
export const ensureUserProvisioned = facade.ensureUserProvisioned;
export const ensureTrustedIdentityProvisioned = facade.ensureTrustedIdentityProvisioned;
export const queryAs = facade.queryAs;
export const queryAsTrustedIdentity = facade.queryAsTrustedIdentity;
export const withUserContext = facade.withUserContext;
export const withRestrictedUserContext = facade.withRestrictedUserContext;
export const withRestrictedTrustedIdentityContext = facade.withRestrictedTrustedIdentityContext;
