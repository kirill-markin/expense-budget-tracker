/**
 * Shared database queries for exchange rate fetcher worker.
 */

import { query } from "./db";
import { addDays, todayIso } from "./dateUtils";
import type { ExchangeRateRow, DateRange } from "./types";

/** Query the earliest transaction date from ledger_entries. */
export async function getEarliestTransactionDate(): Promise<string> {
  const result = await query(
    "SELECT MIN(ts::date)::text AS min_date FROM ledger_entries",
    [],
  );
  if (result.rows[0]?.min_date) {
    return result.rows[0].min_date;
  }
  return addDays(todayIso(), -30);
}

/** Query min and max rate_date per base_currency already in Postgres. */
export async function getRateDateRanges(
  currencies: string[],
): Promise<Record<string, DateRange>> {
  const result = await query(
    "SELECT base_currency, MIN(rate_date)::text AS min_date, MAX(rate_date)::text AS max_date " +
    "FROM exchange_rates " +
    "WHERE base_currency = ANY($1) AND quote_currency = 'USD' " +
    "GROUP BY base_currency",
    [currencies],
  );
  const ranges: Record<string, DateRange> = {};
  for (const row of result.rows) {
    ranges[row.base_currency] = {
      min_date: row.min_date,
      max_date: row.max_date,
    };
  }
  return ranges;
}

/** Insert rows into Postgres using a single batch INSERT. Returns count of actually inserted rows. */
export async function insertRows(rows: ExchangeRateRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < rows.length; i++) {
    const offset = i * 4;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
    params.push(rows[i].base_currency, rows[i].quote_currency, rows[i].rate_date, rows[i].rate);
  }
  const result = await query(
    "INSERT INTO exchange_rates (base_currency, quote_currency, rate_date, rate) " +
    "VALUES " + values.join(", ") + " " +
    "ON CONFLICT (base_currency, quote_currency, rate_date) DO NOTHING",
    params,
  );
  const inserted = result.rowCount ?? 0;
  if (inserted === 0 && rows.length > 0) {
    console.warn("INSERT returned 0 affected rows", { attempted: rows.length });
  }
  return inserted;
}
