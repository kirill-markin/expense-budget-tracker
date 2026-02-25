/**
 * List all workspaces the user is a member of.
 *
 * Uses queryAs with the user's own (default) workspace context so RLS
 * on workspace_members filters by app.user_id. The JOIN to workspaces
 * fetches the display name.
 */
import { queryAs } from "@/server/db";

export type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

export const listWorkspaces = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    `SELECT w.workspace_id, w.name
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
     WHERE wm.user_id = $1
     ORDER BY w.name`,
    [userId],
  );
  return result.rows.map((row) => {
    const r = row as { workspace_id: string; name: string };
    return { workspaceId: r.workspace_id, name: r.name };
  });
};
