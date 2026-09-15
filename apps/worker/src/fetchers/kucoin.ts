/**
 * Fetch daily GRAM/USD exchange rates from KuCoin public market data and insert into Postgres.
 *
 * GRAM is Gram (prev. Toncoin), the native TON coin. No central bank publishes it,
 * so the daily GRAM-USDT market close on KuCoin is used instead of an official rate.
 *
 * The close is stored directly as base_currency=GRAM / quote_currency=USD without
 * inversion, because this worker already treats USDT as exactly 1.00 USD (fetchers/usdt.ts).
 *
 * Only completed UTC days are ingested: today's candle is still forming and insertRows
 * uses ON CONFLICT DO NOTHING, so an intraday value would be frozen forever.
 */

import {
  KUCOIN_CANDLES_URL,
  KUCOIN_GRAM_EARLIEST_DATE,
  KUCOIN_GRAM_SYMBOL,
  KUCOIN_MAX_CANDLES,
} from "../config";
import { addDays, daysBetween, fromEpochSeconds, toEpochSeconds, todayIso } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { FxRawRateRow, DateRange, FetcherResult } from "../types";

const CURRENCY = "GRAM";
const SOURCE = "kucoin";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** One daily candle: [time, open, close, high, low, volume, turnover], all as strings. */
type KucoinCandle = string[];

interface KucoinCandlesResponse {
  code?: string;
  msg?: string;
  data?: KucoinCandle[];
}

// ---------------------------------------------------------------------------
// Pure functions — KuCoin candle parsing
// ---------------------------------------------------------------------------

/**
 * Convert KuCoin daily candles to base_currency=GRAM / quote_currency=USD rows.
 *
 * Candle field 0 is the candle open in epoch seconds at 00:00 UTC, field 2 is the close.
 */
function parseKucoinCandles(candles: KucoinCandle[]): FxRawRateRow[] {
  const rows: FxRawRateRow[] = [];
  for (const candle of candles) {
    if (candle.length < 3) {
      throw new Error(`KuCoin candle has fewer than 3 fields: ${JSON.stringify(candle)}`);
    }
    const openTime = Number(candle[0]);
    if (!Number.isFinite(openTime)) {
      throw new Error(`KuCoin candle has a non-numeric open time: ${JSON.stringify(candle)}`);
    }
    const rateDate = fromEpochSeconds(openTime);
    const close = Number(candle[2]);
    if (!Number.isFinite(close) || close <= 0) {
      throw new Error(
        `KuCoin returned invalid close "${candle[2]}" for date ${rateDate}: ${JSON.stringify(candle)}`,
      );
    }
    rows.push({
      base_currency: CURRENCY,
      quote_currency: "USD",
      rate_date: rateDate,
      rate: close.toFixed(9),
      source: SOURCE,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// KuCoin API
// ---------------------------------------------------------------------------

/**
 * Fetch daily GRAM-USDT candles for an inclusive date range.
 *
 * A response is capped at KUCOIN_MAX_CANDLES and truncates to the newest candles,
 * so the range is walked forward in windows of at most that many days.
 * `endAt` is exclusive: the day after the window end is passed to include its candle.
 */
async function fetchKucoinCandles(start: string, end: string): Promise<KucoinCandle[]> {
  const allCandles: KucoinCandle[] = [];
  let cursor = start;

  while (cursor <= end) {
    const remainingDays = daysBetween(cursor, end) + 1;
    const windowDays = Math.min(remainingDays, KUCOIN_MAX_CANDLES);
    const windowEnd = addDays(cursor, windowDays - 1);
    const startAt = toEpochSeconds(cursor);
    const endAt = toEpochSeconds(addDays(windowEnd, 1));
    const url = `${KUCOIN_CANDLES_URL}?type=1day&symbol=${KUCOIN_GRAM_SYMBOL}&startAt=${startAt}&endAt=${endAt}`;

    console.log("Fetching KuCoin candles", { url, start: cursor, end: windowEnd });

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`KuCoin API error: ${response.status} ${response.statusText} for ${url}`);
    }
    const body = await response.json() as KucoinCandlesResponse;
    if (body.code !== "200000") {
      throw new Error(`KuCoin API returned code ${body.code} (${body.msg}) for ${url}`);
    }
    if (!Array.isArray(body.data)) {
      throw new Error(`KuCoin response has no 'data' array for ${url}`);
    }

    allCandles.push(...body.data);
    cursor = addDays(windowEnd, 1);
  }

  return allCandles;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Keep only rows not already covered by existing data. */
function filterNewRows(
  allRows: FxRawRateRow[],
  existingRange: DateRange | undefined,
): FxRawRateRow[] {
  if (!existingRange) {
    return allRows;
  }
  return allRows.filter(
    (r) => r.rate_date < existingRange.min_date || r.rate_date > existingRange.max_date,
  );
}

/** Main logic: fetch missing GRAM rates from KuCoin and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const dateRanges = await getRateDateRanges([CURRENCY]);
  const existingRange = dateRanges[CURRENCY];

  let start: string;
  if (existingRange) {
    const needsBackfill = existingRange.min_date > KUCOIN_GRAM_EARLIEST_DATE;
    if (needsBackfill) {
      start = KUCOIN_GRAM_EARLIEST_DATE;
    } else {
      start = addDays(existingRange.max_date, 1);
    }
  } else {
    start = KUCOIN_GRAM_EARLIEST_DATE;
  }

  // Yesterday: today's candle is still forming. rebuildDailyRates carries the last
  // raw rate forward for today, exactly as it does for weekends and bank holidays.
  const end = addDays(todayIso(), -1);

  if (start > end) {
    console.log("GRAM rates are up to date");
    return { inserted: 0, latest_date: end };
  }

  const candles = await fetchKucoinCandles(start, end);

  if (candles.length === 0) {
    console.log(`No new candles from KuCoin for period ${start} to ${end}`);
    const latestStr = existingRange ? existingRange.max_date : end;
    return { inserted: 0, latest_date: latestStr };
  }

  const allRows = parseKucoinCandles(candles);
  const newRows = filterNewRows(allRows, existingRange);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`KuCoin: inserted ${inserted} GRAM rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted };
}
