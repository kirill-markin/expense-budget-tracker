/**
 * Shared database queries for exchange rate fetcher worker.
 */

import { query } from "./db";
import type { ExchangeRateRow, DateRange } from "./types";

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

// Max rows per INSERT to stay well within PostgreSQL's 65535 parameter limit.
const INSERT_BATCH_SIZE = 1000;

/** Insert rows into Postgres in batches. Returns total count of actually inserted rows. */
export async function insertRows(rows: ExchangeRateRow[]): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  let totalInserted = 0;
  for (let batchStart = 0; batchStart < rows.length; batchStart += INSERT_BATCH_SIZE) {
    const batch = rows.slice(batchStart, batchStart + INSERT_BATCH_SIZE);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < batch.length; i++) {
      const offset = i * 4;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      params.push(batch[i].base_currency, batch[i].quote_currency, batch[i].rate_date, batch[i].rate);
    }
    const result = await query(
      "INSERT INTO exchange_rates (base_currency, quote_currency, rate_date, rate) " +
      "VALUES " + values.join(", ") + " " +
      "ON CONFLICT (base_currency, quote_currency, rate_date) DO NOTHING",
      params,
    );
    totalInserted += result.rowCount ?? 0;
  }
  if (totalInserted === 0 && rows.length > 0) {
    console.warn("INSERT returned 0 affected rows", { attempted: rows.length });
  }
  return totalInserted;
}
