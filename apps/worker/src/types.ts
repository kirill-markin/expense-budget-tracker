/**
 * Shared type definitions for exchange rate fetcher worker.
 */

export interface ExchangeRateRow {
  base_currency: string;
  quote_currency: string;
  rate_date: string;
  rate: string;
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
