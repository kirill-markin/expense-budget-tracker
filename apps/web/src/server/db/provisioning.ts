import { type PoolClient } from "pg";

import { type SupportedLocale } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { type DbClient, type DbPool } from "@/server/db/contextRunner";
import { getPool } from "@/server/db/pool";
import { getCurrentRequestIdentity } from "@/server/db/requestIdentity";
import { ensureUserSettingsRow, type UserIdentity, upsertUserIdentity } from "@/server/users";
import { WorkspaceAccessError } from "@/server/workspaceErrors";

/** User/workspace pairs already verified to exist in this process. */
const provisionedMemberships = new Set<string>();

/** Users whose settings row is already verified to exist in this process. */
const provisionedUsers = new Set<string>();

/** Stable cache key for membership provisioning checks. */
const getMembershipCacheKey = (userId: string, workspaceId: string): string =>
  `${userId}:${workspaceId}`;

// Only these unique violations are expected during concurrent first-request
// provisioning. The users email mirror can race too: concurrent inserts for the
// same authenticated identity may surface on the secondary unique email index
// before the ON CONFLICT(user_id) branch can resolve the duplicate.
const EXPECTED_PROVISIONING_CONSTRAINTS: ReadonlySet<string> = new Set([
  "idx_users_email",
  "workspaces_pkey",
  "workspace_members_pkey",
  "workspace_settings_pkey",
]);

type PgError = Error & Readonly<{
  code?: string;
  constraint?: string;
}>;

type ProvisioningDependencies = Readonly<{
  pool: DbPool;
  getInitialLocale: () => Promise<SupportedLocale>;
  upsertIdentity: (client: DbClient, identity: UserIdentity) => Promise<void>;
  ensureUserSettings: (client: DbClient, userId: string, locale: SupportedLocale) => Promise<void>;
}>;

const createProvisioningDependencies = (): ProvisioningDependencies => ({
  pool: getPool(),
  getInitialLocale: getLocaleCookie,
  upsertIdentity: async (client, identity) => upsertUserIdentity(client as PoolClient, identity),
  ensureUserSettings: async (client, userId, locale) => ensureUserSettingsRow(client as PoolClient, userId, locale),
});

/** Narrow PostgreSQL unique-violation handling to known concurrent inserts. */
const isExpectedProvisioningConflict = (error: unknown): boolean => {
  const pgError = error as PgError;
  return pgError.code === "23505"
    && typeof pgError.constraint === "string"
    && EXPECTED_PROVISIONING_CONSTRAINTS.has(pgError.constraint);
};

/**
 * Re-read the required rows after an expected race conflict.
 *
 * This avoids marking in-memory caches as provisioned until the committed DB
 * state is known to contain every row the rest of the app relies on.
 */
const verifyProvisionedState = async (
  pool: DbPool,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    const missing: Array<string> = [];

    const userCheck = await client.query(
      "SELECT 1 FROM users WHERE user_id = $1",
      [userId],
    );
    if (userCheck.rows.length === 0) {
      missing.push("users");
    }

    const membershipCheck = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    if (membershipCheck.rows.length === 0) {
      missing.push("workspace_members");
    }

    const workspaceSettingsCheck = await client.query(
      "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
      [workspaceId],
    );
    if (workspaceSettingsCheck.rows.length === 0) {
      missing.push("workspace_settings");
    }

    const userSettingsCheck = await client.query(
      "SELECT 1 FROM user_settings WHERE user_id = $1",
      [userId],
    );
    if (userSettingsCheck.rows.length === 0) {
      missing.push("user_settings");
    }

    await client.query("COMMIT");
    committed = true;

    if (missing.length > 0) {
      throw new Error(
        `Provisioning verification failed for user ${userId} in workspace ${workspaceId}: missing ${missing.join(", ")}`,
      );
    }
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
  }
};

export const ensureProvisionedIdentity = async (
  identity: UserIdentity,
  workspaceId: string,
  dependencies: ProvisioningDependencies,
): Promise<void> => {
  const userId = identity.userId;
  const initialLocale = await dependencies.getInitialLocale();
  const membershipKey = getMembershipCacheKey(userId, workspaceId);
  const shouldCacheMembership = !provisionedMemberships.has(membershipKey);
  const shouldCacheUser = !provisionedUsers.has(userId);
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await dependencies.upsertIdentity(client, identity);

    if (shouldCacheMembership) {
      const check = await client.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );

      if (check.rows.length === 0) {
        throw new WorkspaceAccessError(userId, workspaceId);
      }

      const settingsCheck = await client.query(
        "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
        [workspaceId],
      );
      if (settingsCheck.rows.length === 0) {
        await client.query(
          "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD')",
          [workspaceId],
        );
      }
    }

    if (shouldCacheUser) {
      await dependencies.ensureUserSettings(client, userId, initialLocale);
    }

    await client.query("COMMIT");
    if (shouldCacheMembership) {
      provisionedMemberships.add(membershipKey);
    }
    if (shouldCacheUser) {
      provisionedUsers.add(userId);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    if (isExpectedProvisioningConflict(error)) {
      await verifyProvisionedState(dependencies.pool, userId, workspaceId);
      provisionedMemberships.add(membershipKey);
      provisionedUsers.add(userId);
      return;
    }
    throw error;
  } finally {
    client.release();
  }
};

export const ensureUserProvisionedWithResolver = async (
  resolveIdentity: () => Promise<UserIdentity>,
  ensureProvisioned: (identity: UserIdentity, workspaceId: string) => Promise<void>,
  userId: string,
  workspaceId: string,
): Promise<void> => {
  const identity = await resolveIdentity();
  if (identity.userId !== userId) {
    throw new Error(`Identity header mismatch: expected user ${userId}, got ${identity.userId}`);
  }
  await ensureProvisioned(identity, workspaceId);
};

/**
 * Ensure the current user identity mirror and required rows exist.
 *
 * Uses in-memory caches for stable rows (workspace membership and user
 * settings) but always upserts the users row so active identities stay
 * synchronized.
 *
 * Workspace bootstrap happens separately. By the time request handling reaches
 * this helper, the active workspace must already be a valid membership.
 */
export const ensureUserProvisioned = async (userId: string, workspaceId: string): Promise<void> => {
  const dependencies = createProvisioningDependencies();
  await ensureUserProvisionedWithResolver(
    getCurrentRequestIdentity,
    async (identity, currentWorkspaceId) => ensureProvisionedIdentity(identity, currentWorkspaceId, dependencies),
    userId,
    workspaceId,
  );
};

/**
 * Ensure a trusted non-session identity is provisioned for app-side agent
 * routes. The caller is responsible for validating the identity first.
 */
export const ensureTrustedIdentityProvisioned = async (
  identity: UserIdentity,
  workspaceId: string,
): Promise<void> => {
  await ensureProvisionedIdentity(identity, workspaceId, createProvisioningDependencies());
};

export const resetProvisioningCachesForTests = (): void => {
  provisionedMemberships.clear();
  provisionedUsers.clear();
};
