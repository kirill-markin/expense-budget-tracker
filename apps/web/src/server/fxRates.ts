/**
 * Shared helpers for the FX read model.
 *
 * The application never reads raw market rates directly. All dashboard and API
 * queries must use fx_rates_daily, which already contains exact-date all-pairs
 * rates with weekend/holiday carry-forward applied by the worker.
 */

import { query } from "@/server/db";

/**
 * Return the latest calendar day covered by the query-ready FX table.
 *
 * This is the single anchor day used by "latest balances" style reads so every
 * current snapshot resolves currencies against the same FX build.
 */
export const getLatestFxCalendarDate = async (): Promise<string> => {
  const result = await query(
    "SELECT MAX(calendar_date)::text AS latest_calendar_date FROM fx_rates_daily",
    [],
  );
  const latestCalendarDate = (result.rows[0] as { latest_calendar_date: string | null } | undefined)?.latest_calendar_date;
  if (latestCalendarDate === null || latestCalendarDate === undefined) {
    throw new Error("fx_rates_daily is empty: no latest FX calendar date is available");
  }
  return latestCalendarDate;
};
