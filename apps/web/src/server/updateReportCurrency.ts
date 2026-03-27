/**
 * Per-workspace reporting currency updater.
 *
 * Updates workspace_settings.reporting_currency for the given workspace.
 * Validates both the currency format and derived FX coverage before writing.
 */
import { queryAs } from "@/server/db";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Updates the reporting currency and returns the stored value. */
export const updateReportCurrency = async (
  userId: string,
  workspaceId: string,
  currency: string,
): Promise<string> => {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new Error(`Invalid currency code: "${currency}". Expected 3-letter ISO 4217 code`);
  }
  const availableCurrencies = await getAvailableCurrencies();
  if (!availableCurrencies.includes(currency)) {
    throw new Error(`Unsupported reporting currency: "${currency}". Available values: ${availableCurrencies.join(", ")}`);
  }
  const result = await queryAs(
    userId,
    workspaceId,
    "UPDATE workspace_settings SET reporting_currency = $2 WHERE workspace_id = $1 RETURNING reporting_currency",
    [workspaceId, currency],
  );
  if (result.rows.length === 0) {
    throw new Error(`workspace_settings row missing for workspace ${workspaceId}`);
  }
  return (result.rows[0] as { reporting_currency: string }).reporting_currency;
};
