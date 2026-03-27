/**
 * Shared type definitions for the FX worker.
 *
 * The worker owns two distinct representations:
 * - raw source rates in the internal pivot currency (USD)
 * - query-ready daily all-pairs rates derived from those raw rows
 *
 * Keeping the types separate makes the cutover intent explicit in code and
 * avoids the old mental model where application reads touched the same table
 * that ingestion wrote.
 */

export interface FxRawRateRow {
  base_currency: string;
  quote_currency: string;
  rate_date: string;
  rate: string;
  source: string;
}

export interface DateRange {
  min_date: string;
  max_date: string;
}

export interface FetcherResult {
  inserted: number;
  latest_date: string;
  missing_currencies?: string[];
}

export interface RebuildDailyRatesResult {
  inserted: number;
  latest_calendar_date: string;
}

export type FetcherOutcome =
  | { status: "ok"; result: FetcherResult }
  | { status: "error"; error: string };
