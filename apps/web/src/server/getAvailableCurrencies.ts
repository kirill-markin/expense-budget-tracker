/**
 * Available reporting currencies resolver.
 *
 * Reporting currencies are derived from the query-ready FX table, not from raw
 * source rates. This guarantees that the settings screen exposes only values
 * that can be resolved by exact-date joins in the rest of the app.
 *
 * Uses query() (no RLS context) because fx_rates_daily is a global table.
 */
import { query } from "@/server/db";

/** Returns sorted array of currency codes that have exchange rates available. */
export const getAvailableCurrencies = async (): Promise<ReadonlyArray<string>> => {
  const result = await query(
    `
      WITH latest_day AS (
        SELECT MAX(calendar_date) AS calendar_date
        FROM fx_rates_daily
      )
      SELECT DISTINCT quote_currency
      FROM fx_rates_daily
      WHERE calendar_date = (SELECT calendar_date FROM latest_day)
      ORDER BY quote_currency
    `,
    [],
  );
  return (result.rows as ReadonlyArray<{ quote_currency: string }>).map((r) => r.quote_currency);
};
