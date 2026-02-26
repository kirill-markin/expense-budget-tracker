/**
 * Generate static USDT/USD exchange rate rows and insert into Postgres.
 *
 * USDT (Tether) is pegged 1:1 to USD. No external API call is needed —
 * rows are generated locally with a fixed rate of 1.0 for every calendar day.
 */

import { addDays, todayIso } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { ExchangeRateRow, DateRange, FetcherResult } from "../types";

const CURRENCY = "USDT";
const RATE = "1.000000000";
const EARLIEST_DATE = "2009-01-03";

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/** Generate one USDT/USD row per calendar day for the given date range. */
function generateRows(start: string, end: string): ExchangeRateRow[] {
  const rows: ExchangeRateRow[] = [];
  let cursor = start;
  while (cursor <= end) {
    rows.push({
      base_currency: CURRENCY,
      quote_currency: "USD",
      rate_date: cursor,
      rate: RATE,
    });
    cursor = addDays(cursor, 1);
  }
  return rows;
}

/** Keep only rows not already covered by existing data. */
function filterNewRows(
  allRows: ExchangeRateRow[],
  existingRange: DateRange | undefined,
): ExchangeRateRow[] {
  if (!existingRange) {
    return allRows;
  }
  return allRows.filter(
    (r) => r.rate_date < existingRange.min_date || r.rate_date > existingRange.max_date,
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Main logic: generate missing USDT/USD rows and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const dateRanges = await getRateDateRanges([CURRENCY]);
  const existingRange = dateRanges[CURRENCY];

  let start: string;
  if (existingRange) {
    const needsBackfill = existingRange.min_date > EARLIEST_DATE;
    if (needsBackfill) {
      start = EARLIEST_DATE;
    } else {
      start = addDays(existingRange.max_date, 1);
    }
  } else {
    start = EARLIEST_DATE;
  }

  const end = todayIso();

  if (start > end) {
    console.log("USDT rates are up to date");
    return { inserted: 0, latest_date: end };
  }

  const allRows = generateRows(start, end);
  const newRows = filterNewRows(allRows, existingRange);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`USDT: inserted ${inserted} rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted };
}
