/**
 * Per-workspace reporting currency resolver.
 *
 * Reads workspace_settings for the given workspace to determine which currency
 * all monetary values should be converted to in API responses and dashboard views.
 * The workspace_settings row is guaranteed to exist — ensureWorkspace() in db.ts
 * creates it on first request.
 */
import { queryAs } from "@/server/db";

/** Returns the reporting currency code (e.g. "USD", "EUR") for the given workspace. */
export const getReportCurrency = async (userId: string, workspaceId: string): Promise<string> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT reporting_currency FROM workspace_settings WHERE workspace_id = $1",
    [workspaceId],
  );
  if (result.rows.length === 0) {
    throw new Error(`workspace_settings row missing for workspace ${workspaceId}`);
  }
  return (result.rows[0] as { reporting_currency: string }).reporting_currency;
};
