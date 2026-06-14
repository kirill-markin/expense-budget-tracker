import { type PoolClient } from "pg";

import { type SupportedLocale } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { getBrowserTimezoneCookie } from "@/lib/timezoneCookie";
import { getPool } from "@/server/db/pool";
import { ensureUserSettingsRow, type UserIdentity, upsertUserIdentity } from "@/server/users";

export const DEFAULT_FIRST_WORKSPACE_NAME = "My Workspace";
const DEFAULT_WORKSPACE_TIMEZONE = "UTC";

type WorkspaceRow = Readonly<{
  workspace_id: string;
  name: string;
}>;

type ResolvedWorkspaceRow = Readonly<{
  workspace_id: string;
  name: string;
  created: boolean;
}>;

export type ResolvedWorkspace = Readonly<{
  workspaceId: string;
  name: string;
  created: boolean;
  requestedWorkspaceAccessible: boolean;
}>;

const WORKSPACE_BY_ID_FOR_USER_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE w.workspace_id = $1
    AND wm.user_id = $2`;

const ensureWorkspaceSettingsRow = async (
  client: PoolClient,
  workspaceId: string,
  timezone: string,
): Promise<void> => {
  await client.query(
    `INSERT INTO workspace_settings (workspace_id, reporting_currency, timezone)
     VALUES ($1, 'USD', $2)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId, timezone],
  );
};

const mapWorkspaceRow = (row: WorkspaceRow): Readonly<{ workspaceId: string; name: string }> => ({
  workspaceId: row.workspace_id,
  name: row.name,
});

const mapResolvedWorkspaceRow = (row: ResolvedWorkspaceRow): ResolvedWorkspace => ({
  workspaceId: row.workspace_id,
  name: row.name,
  created: row.created,
  requestedWorkspaceAccessible: false,
});

export const resolveWorkspaceForIdentity = async (
  identity: UserIdentity,
  requestedWorkspaceId: string,
  initialLocale: SupportedLocale,
  initialTimezone: string | null,
): Promise<ResolvedWorkspace> => {
  const client = await getPool().connect();
  const workspaceTimezone = initialTimezone ?? DEFAULT_WORKSPACE_TIMEZONE;

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [identity.userId]);
    await upsertUserIdentity(client, identity);
    await ensureUserSettingsRow(client, identity.userId, initialLocale);

    if (requestedWorkspaceId !== "") {
      const requestedWorkspaceResult = await client.query(
        WORKSPACE_BY_ID_FOR_USER_SQL,
        [requestedWorkspaceId, identity.userId],
      );

      if (requestedWorkspaceResult.rows.length === 1) {
        const workspace = mapWorkspaceRow(requestedWorkspaceResult.rows[0] as WorkspaceRow);
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspace.workspaceId]);
        await ensureWorkspaceSettingsRow(client, workspace.workspaceId, workspaceTimezone);
        await client.query("COMMIT");
        return {
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          created: false,
          requestedWorkspaceAccessible: true,
        };
      }
    }

    const resolvedWorkspaceResult = await client.query(
      "SELECT workspace_id, name, created FROM ensure_current_user_has_workspace($1, $2)",
      [DEFAULT_FIRST_WORKSPACE_NAME, workspaceTimezone],
    );

    if (resolvedWorkspaceResult.rows.length !== 1) {
      throw new Error(`ensure_current_user_has_workspace returned ${resolvedWorkspaceResult.rows.length} rows`);
    }

    const resolvedWorkspace = mapResolvedWorkspaceRow(resolvedWorkspaceResult.rows[0] as ResolvedWorkspaceRow);
    await client.query("COMMIT");
    return resolvedWorkspace;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const resolveWorkspaceForCurrentRequestIdentity = async (
  identity: UserIdentity,
  requestedWorkspaceId: string,
): Promise<ResolvedWorkspace> => {
  const [initialLocale, initialTimezone] = await Promise.all([
    getLocaleCookie(),
    getBrowserTimezoneCookie(),
  ]);

  return resolveWorkspaceForIdentity(identity, requestedWorkspaceId, initialLocale, initialTimezone);
};
