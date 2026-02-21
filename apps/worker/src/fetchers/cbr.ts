/**
 * Fetch daily RUB/USD exchange rates from the Bank of Russia and insert into Postgres.
 *
 * Fetches USD/RUB rates from the CBR XML API, converts to
 * base_currency=RUB / quote_currency=USD pairs,
 * and inserts missing dates into exchange_rates.
 *
 * CBR publishes rates as "RUB per Nominal units of foreign currency".
 * For USD: Nominal=1, Value=77.0223 means 1 USD = 77.0223 RUB.
 * So 1 RUB = 1/77.0223 USD, i.e. rate = Nominal / Value.
 */

import { XMLParser } from "fast-xml-parser";
import { CBR_BASE_URL, CBR_USD_ID } from "../config";
import { addDays, todayIso, formatDdMmYyyy } from "../dateUtils";
import { getEarliestTransactionDate, getRateDateRanges, insertRows } from "../dbQueries";
import type { ExchangeRateRow, DateRange, FetcherResult } from "../types";

const CURRENCY = "RUB";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface CBRRecord {
  rate_date: string;
  nominal: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Pure functions — CBR XML parsing
// ---------------------------------------------------------------------------

/** Parse CBR decimal format (comma as separator): '77,0223' -> 77.0223. */
function parseCbrDecimal(raw: string): number {
  const cleaned = raw.trim().replace(",", ".");
  const value = Number(cleaned);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid CBR decimal value: ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Parse CBR date format: 'DD.MM.YYYY' -> 'YYYY-MM-DD'. */
function parseCbrDate(raw: string): string {
  const parts = raw.trim().split(".");
  if (parts.length !== 3) {
    throw new Error(`Invalid CBR date format: ${JSON.stringify(raw)}`);
  }
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

/** Parse CBR XML_dynamic.asp response into a list of records. */
function parseCbrXml(xmlText: string): CBRRecord[] {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xmlText);
  const root = parsed.ValCurs;
  if (!root) {
    throw new Error("CBR XML missing ValCurs root element");
  }

  let recordEls = root.Record;
  if (!recordEls) {
    return [];
  }
  if (!Array.isArray(recordEls)) {
    recordEls = [recordEls];
  }

  const records: CBRRecord[] = [];
  for (const el of recordEls) {
    const dateAttr = el["@_Date"];
    if (!dateAttr) {
      throw new Error("CBR Record element missing Date attribute");
    }
    const nominalText = String(el.Nominal);
    const valueText = String(el.Value);
    if (!nominalText) {
      throw new Error(`CBR Record missing Nominal element for date ${dateAttr}`);
    }
    if (!valueText) {
      throw new Error(`CBR Record missing Value element for date ${dateAttr}`);
    }
    records.push({
      rate_date: parseCbrDate(dateAttr),
      nominal: parseInt(nominalText.trim(), 10),
      value: parseCbrDecimal(valueText),
    });
  }
  return records;
}

/**
 * Convert CBR USD/RUB records to base_currency=RUB / quote_currency=USD.
 *
 * CBR gives: 1 USD = Value/Nominal RUB (Nominal is always 1 for USD).
 * We need: 1 RUB = ? USD -> rate = Nominal / Value.
 */
function convertCbrToUsd(records: CBRRecord[]): ExchangeRateRow[] {
  const rows: ExchangeRateRow[] = [];
  for (const record of records) {
    if (record.value === 0) {
      throw new Error(`CBR returned zero rate for date ${record.rate_date}`);
    }
    const rate = record.nominal / record.value;
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
// CBR API
// ---------------------------------------------------------------------------

/** Fetch USD/RUB rates from CBR XML_dynamic.asp endpoint. */
async function fetchCbrRates(start: string, end: string): Promise<string> {
  const params = new URLSearchParams({
    date_req1: formatDdMmYyyy(start),
    date_req2: formatDdMmYyyy(end),
    VAL_NM_RQ: CBR_USD_ID,
  });
  const url = `${CBR_BASE_URL}?${params.toString()}`;

  console.log("Fetching CBR rates", { url });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CBR API error: ${response.status} ${response.statusText}`);
  }
  return response.text();
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

/** Main logic: fetch missing RUB rates from CBR and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const dateRanges = await getRateDateRanges([CURRENCY]);
  const existingRange = dateRanges[CURRENCY];
  const targetStart = await getEarliestTransactionDate();

  let start: string;
  if (existingRange) {
    const needsBackfill = existingRange.min_date > targetStart;
    if (needsBackfill) {
      start = targetStart;
    } else {
      start = addDays(existingRange.max_date, 1);
    }
  } else {
    start = targetStart;
  }

  const end = todayIso();

  if (start > end) {
    console.log("RUB rates are up to date");
    return { inserted: 0, latest_date: end };
  }

  const xmlText = await fetchCbrRates(start, end);
  const records = parseCbrXml(xmlText);

  if (records.length === 0) {
    console.log(`No new records from CBR for period ${start} to ${end}`);
    const latestStr = existingRange ? existingRange.max_date : end;
    return { inserted: 0, latest_date: latestStr };
  }

  const allRows = convertCbrToUsd(records);
  const newRows = filterNewRows(allRows, existingRange);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`CBR: inserted ${inserted} RUB rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted };
}
