/**
 * Per-user reporting currency resolver.
 *
 * Reads workspace_settings for the given user to determine which currency
 * all monetary values should be converted to in API responses and dashboard views.
 * Auto-provisions a default 'USD' row for new users on first access.
 */
import { queryAs } from "@/server/db";

/** Returns the reporting currency code (e.g. "USD", "EUR") for the given user. */
export const getReportCurrency = async (userId: string): Promise<string> => {
  const result = await queryAs(
    userId,
    "SELECT reporting_currency FROM workspace_settings WHERE user_id = $1",
    [userId],
  );
  if (result.rows.length === 0) {
    await queryAs(
      userId,
      "INSERT INTO workspace_settings (user_id, reporting_currency) VALUES ($1, 'USD') ON CONFLICT (user_id) DO NOTHING",
      [userId],
    );
    return "USD";
  }
  return (result.rows[0] as { reporting_currency: string }).reporting_currency;
};
