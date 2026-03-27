/**
 * Rebuild the query-ready FX table from canonical raw pivot rates.
 *
 * Why this module exists:
 * - fx_rates_raw is the ingestion truth and always stores rates against USD
 * - fx_rates_daily is the application read model and stores every supported
 *   base->quote pair for every calendar day
 *
 * The rebuild step intentionally centralizes all pair derivation here so the
 * dashboards do not have to repeat cross-currency logic in their own SQL.
 */

import { query, withClient } from "./db";
import type { RebuildDailyRatesResult } from "./types";

const REBUILD_DAILY_RATES_SQL = `
  WITH bounds AS (
    SELECT
      MIN(rate_date) AS min_date,
      MAX(rate_date) AS max_date
    FROM fx_rates_raw
  ),
  validated_bounds AS (
    SELECT
      min_date,
      max_date
    FROM bounds
    WHERE min_date IS NOT NULL
      AND max_date IS NOT NULL
  ),
  raw_ranges AS (
    SELECT
      base_currency AS currency,
      rate_date AS range_start,
      COALESCE(
        LEAD(rate_date) OVER (
          PARTITION BY base_currency
          ORDER BY rate_date
        ) - INTERVAL '1 day',
        (SELECT max_date FROM validated_bounds)
      )::date AS range_end,
      rate,
      rate_date AS source_rate_date
    FROM fx_rates_raw
    WHERE quote_currency = 'USD'
  ),
  usd_daily AS (
    SELECT
      'USD'::text AS currency,
      d::date AS calendar_date,
      1::numeric AS rate_to_usd,
      d::date AS source_rate_date
    FROM validated_bounds vb
    CROSS JOIN LATERAL generate_series(vb.min_date, vb.max_date, INTERVAL '1 day') AS d
  ),
  pivot_daily AS (
    SELECT
      rr.currency,
      d::date AS calendar_date,
      rr.rate,
      rr.source_rate_date
    FROM raw_ranges rr
    CROSS JOIN LATERAL generate_series(rr.range_start, rr.range_end, INTERVAL '1 day') AS d
    UNION ALL
    SELECT
      ud.currency,
      ud.calendar_date,
      ud.rate_to_usd AS rate,
      ud.source_rate_date
    FROM usd_daily ud
  ),
  inserted_rows AS (
    INSERT INTO fx_rates_daily (
      base_currency,
      quote_currency,
      calendar_date,
      rate,
      source_rate_date
    )
    SELECT
      base.currency AS base_currency,
      quote.currency AS quote_currency,
      base.calendar_date,
      CASE
        WHEN base.currency = quote.currency THEN 1::numeric
        ELSE ROUND((base.rate / quote.rate)::numeric, 9)
      END AS rate,
      CASE
        WHEN base.currency = quote.currency THEN base.calendar_date
        ELSE GREATEST(base.source_rate_date, quote.source_rate_date)
      END AS source_rate_date
    FROM pivot_daily base
    INNER JOIN pivot_daily quote
      ON quote.calendar_date = base.calendar_date
    RETURNING calendar_date
  )
  SELECT
    COUNT(*)::int AS inserted_count,
    MAX(calendar_date)::text AS latest_calendar_date
  FROM inserted_rows
`;

/**
 * Rebuild the entire daily all-pairs FX table in one pass.
 *
 * v1 intentionally uses truncate-and-repopulate because the dataset is small
 * and the product explicitly does not preserve legacy dual-read behavior.
 */
export const rebuildDailyRates = async (): Promise<RebuildDailyRatesResult> => {
  const rawCountResult = await query("SELECT COUNT(*)::int AS row_count FROM fx_rates_raw", []);
  const rawCount = Number((rawCountResult.rows[0] as { row_count: string | number }).row_count);
  if (rawCount === 0) {
    throw new Error("Cannot rebuild fx_rates_daily: fx_rates_raw is empty");
  }

  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("TRUNCATE TABLE fx_rates_daily");
      const rebuildResult = await client.query(REBUILD_DAILY_RATES_SQL);
      const row = rebuildResult.rows[0] as {
        inserted_count: string | number;
        latest_calendar_date: string | null;
      } | undefined;
      if (row === undefined || row.latest_calendar_date === null) {
        throw new Error("Failed to rebuild fx_rates_daily: rebuild query returned no coverage");
      }
      await client.query("COMMIT");
      return {
        inserted: Number(row.inserted_count),
        latest_calendar_date: row.latest_calendar_date,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
};
