/**
 * Fetch daily UAH/USD exchange rates from the National Bank of Ukraine and insert into Postgres.
 *
 * Fetches USD/UAH rates from the NBU API (official data),
 * converts to base_currency=UAH / quote_currency=USD pairs,
 * and inserts missing dates into exchange_rates.
 *
 * NBU publishes rates as "UAH per 1 unit of foreign currency".
 * For USD: rate=41.2948 means 1 USD = 41.2948 UAH.
 * So 1 UAH = 1/41.2948 USD, i.e. rate = 1 / rate.
 */

import { NBU_BASE_URL, NBU_EARLIEST_DATE } from "../config";
import { todayIso, addDays } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { ExchangeRateRow, DateRange, FetcherResult } from "../types";

const CURRENCY = "UAH";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface NBURecord {
  rate_date: string;
  rate: number;
}

interface NBUApiEntry {
  exchangedate?: string;
  rate?: number;
  cc?: string;
}

// ---------------------------------------------------------------------------
// Pure functions — NBU JSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse NBU API JSON array into a list of records.
 *
 * Each entry has 'exchangedate' (DD.MM.YYYY) and 'rate' (number).
 */
function parseNbuResponse(data: NBUApiEntry[]): NBURecord[] {
  const records: NBURecord[] = [];
  for (const entry of data) {
    if (entry.exchangedate === undefined) {
      throw new Error(`NBU response entry missing 'exchangedate' field: ${JSON.stringify(entry)}`);
    }
    if (entry.rate === undefined) {
      throw new Error(`NBU response entry missing 'rate' field for date ${entry.exchangedate}`);
    }
    if (entry.rate === 0) {
      throw new Error(`NBU returned zero rate for date ${entry.exchangedate}`);
    }
    const [day, month, year] = entry.exchangedate.split(".");
    records.push({
      rate_date: `${year}-${month}-${day}`,
      rate: entry.rate,
    });
  }
  return records;
}

/**
 * Convert NBU USD/UAH records to base_currency=UAH / quote_currency=USD.
 *
 * NBU gives: 1 USD = rate UAH.
 * We need: 1 UAH = ? USD -> rate = 1 / rate.
 */
function convertNbuToUsd(records: NBURecord[]): ExchangeRateRow[] {
  const rows: ExchangeRateRow[] = [];
  for (const record of records) {
    const rate = 1 / record.rate;
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
// NBU API
// ---------------------------------------------------------------------------

/**
 * Fetch USD/UAH rates from NBU API for a date range.
 *
 * NBU supports date ranges natively — single request for the full period.
 */
async function fetchNbuRates(start: string, end: string): Promise<NBUApiEntry[]> {
  const startParam = start.replace(/-/g, "");
  const endParam = end.replace(/-/g, "");
  const url = `${NBU_BASE_URL}?start=${startParam}&end=${endParam}&valcode=usd&sort=exchangedate&order=asc&json`;

  console.log("Fetching NBU rates", { url, start, end });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NBU API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as NBUApiEntry[];

  return data;
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

/** Main logic: fetch missing UAH rates from NBU and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const dateRanges = await getRateDateRanges([CURRENCY]);
  const existingRange = dateRanges[CURRENCY];

  let start: string;
  if (existingRange) {
    const needsBackfill = existingRange.min_date > NBU_EARLIEST_DATE;
    if (needsBackfill) {
      start = NBU_EARLIEST_DATE;
    } else {
      start = addDays(existingRange.max_date, 1);
    }
  } else {
    start = NBU_EARLIEST_DATE;
  }

  const end = todayIso();

  if (start > end) {
    console.log("UAH rates are up to date");
    return { inserted: 0, latest_date: end };
  }

  const rawEntries = await fetchNbuRates(start, end);
  const records = parseNbuResponse(rawEntries);

  if (records.length === 0) {
    console.log(`No new records from NBU for period ${start} to ${end}`);
    const latestStr = existingRange ? existingRange.max_date : end;
    return { inserted: 0, latest_date: latestStr };
  }

  const allRows = convertNbuToUsd(records);
  const newRows = filterNewRows(allRows, existingRange);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`NBU: inserted ${inserted} UAH rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted };
}
