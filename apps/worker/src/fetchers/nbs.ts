/**
 * Fetch daily RSD/USD exchange rates from the National Bank of Serbia and insert into Postgres.
 *
 * Fetches USD/RSD rates from the kurs.resenje.org API (official NBS data),
 * converts to base_currency=RSD / quote_currency=USD pairs,
 * and inserts missing dates into exchange_rates.
 *
 * NBS publishes rates as "RSD per 1 unit of foreign currency".
 * For USD: exchange_middle=98.9309 means 1 USD = 98.9309 RSD.
 * So 1 RSD = 1/98.9309 USD, i.e. rate = 1 / exchange_middle.
 */

import { NBS_API_BASE_URL, NBS_EARLIEST_DATE, NBS_MAX_COUNT } from "../config";
import { addDays, daysBetween, todayIso } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { ExchangeRateRow, DateRange, FetcherResult } from "../types";

const CURRENCY = "RSD";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface NBSRecord {
  rate_date: string;
  exchange_middle: number;
}

interface NBSApiEntry {
  date?: string;
  exchange_middle?: number;
  rates?: NBSApiEntry[];
}

// ---------------------------------------------------------------------------
// Pure functions — NBS JSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse kurs.resenje.org API response into a list of records.
 *
 * Single-rate response has fields directly on the object.
 * Multi-rate response has a 'rates' array.
 */
function parseNbsResponse(data: NBSApiEntry): NBSRecord[] {
  let rawRates: NBSApiEntry[];
  if (data.rates) {
    rawRates = data.rates;
  } else {
    rawRates = [data];
  }

  const records: NBSRecord[] = [];
  for (const entry of rawRates) {
    if (entry.date === undefined) {
      throw new Error(`NBS response entry missing 'date' field: ${JSON.stringify(entry)}`);
    }
    if (entry.exchange_middle === undefined) {
      throw new Error(`NBS response entry missing 'exchange_middle' field for date ${entry.date}`);
    }
    if (entry.exchange_middle === 0) {
      throw new Error(`NBS returned zero exchange_middle for date ${entry.date}`);
    }
    records.push({
      rate_date: entry.date,
      exchange_middle: entry.exchange_middle,
    });
  }
  return records;
}

/**
 * Convert NBS USD/RSD records to base_currency=RSD / quote_currency=USD.
 *
 * NBS gives: 1 USD = exchange_middle RSD.
 * We need: 1 RSD = ? USD -> rate = 1 / exchange_middle.
 */
function convertNbsToUsd(records: NBSRecord[]): ExchangeRateRow[] {
  const rows: ExchangeRateRow[] = [];
  for (const record of records) {
    const rate = 1 / record.exchange_middle;
    rows.push({
      base_currency: CURRENCY,
      quote_currency: "USD",
      rate_date: record.rate_date,
      rate: rate.toFixed(9),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// NBS API
// ---------------------------------------------------------------------------

/**
 * Fetch USD/RSD rates from kurs.resenje.org for a date range.
 *
 * The API supports up to 1000 days per request via the /count/ endpoint.
 * For ranges exceeding 1000 days, multiple sequential requests are made.
 */
async function fetchNbsRates(start: string, end: string): Promise<NBSApiEntry[]> {
  const allEntries: NBSApiEntry[] = [];
  let cursor = start;

  while (cursor <= end) {
    const remainingDays = daysBetween(cursor, end) + 1;
    const count = Math.min(remainingDays, NBS_MAX_COUNT);
    const url = `${NBS_API_BASE_URL}/currencies/usd/rates/${cursor}/count/${count}`;

    console.log("Fetching NBS rates", { url, start: cursor, count });

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`NBS API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json() as NBSApiEntry;

    if (data.rates) {
      allEntries.push(...data.rates);
    } else {
      allEntries.push(data);
    }

    cursor = addDays(cursor, count);
  }

  return allEntries;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

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

/** Main logic: fetch missing RSD rates from NBS and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const dateRanges = await getRateDateRanges([CURRENCY]);
  const existingRange = dateRanges[CURRENCY];

  let start: string;
  if (existingRange) {
    const needsBackfill = existingRange.min_date > NBS_EARLIEST_DATE;
    if (needsBackfill) {
      start = NBS_EARLIEST_DATE;
    } else {
      start = addDays(existingRange.max_date, 1);
    }
  } else {
    start = NBS_EARLIEST_DATE;
  }

  const end = todayIso();

  if (start > end) {
    console.log("RSD rates are up to date");
    return { inserted: 0, latest_date: end };
  }

  const rawEntries = await fetchNbsRates(start, end);
  const records = parseNbsResponse({ rates: rawEntries });

  if (records.length === 0) {
    console.log(`No new records from NBS for period ${start} to ${end}`);
    const latestStr = existingRange ? existingRange.max_date : end;
    return { inserted: 0, latest_date: latestStr };
  }

  const allRows = convertNbsToUsd(records);
  const newRows = filterNewRows(allRows, existingRange);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`NBS: inserted ${inserted} RSD rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted };
}
