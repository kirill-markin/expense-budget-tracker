/**
 * Workspace reporting currency resolver.
 *
 * Reads the single-row workspace_settings table to determine which currency
 * all monetary values should be converted to in API responses and dashboard views.
 */
import { query } from "@/server/db";

/** Returns the reporting currency code (e.g. "USD", "EUR") from workspace_settings. */
export const getReportCurrency = async (): Promise<string> => {
  const result = await query(
    "SELECT reporting_currency FROM workspace_settings WHERE id = 1",
    [],
  );
  return (result.rows[0] as { reporting_currency: string }).reporting_currency;
};
