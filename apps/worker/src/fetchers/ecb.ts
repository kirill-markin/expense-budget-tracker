/**
 * Fetch daily exchange rates from ECB and insert into Postgres.
 *
 * Fetches EUR-based rates from the ECB SDMX REST API, converts to
 * base_currency/quote_currency/rate pairs (quote_currency=USD),
 * and inserts missing dates into fx_rates_raw.
 */

import { ECB_BASE_URL, ECB_CURRENCIES, ECB_EARLIEST_DATE } from "../config";
import { addDays, daysBetween, todayIso } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { FxRawRateRow, DateRange, FetcherResult } from "../types";

const SOURCE = "ecb";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface ECBRate {
  currency: string;
  rate_date: string;
  rate_eur: number;
}

// ---------------------------------------------------------------------------
// Pure functions — ECB data parsing
// ---------------------------------------------------------------------------

/**
 * Parse ECB CSV response into a list of rates.
 *
 * ECB CSV columns include CURRENCY, TIME_PERIOD, OBS_VALUE among others.
 * Each row is one daily rate: how many units of CURRENCY per 1 EUR.
 *
 * A period that contains no observations — a weekend, a TARGET holiday, or the
 * hours before the ~16:00 CET publication — is answered with HTTP 200 and a
 * completely empty body, not with a header-only CSV, so that is zero rates.
 */
function parseEcbCsv(csvText: string): ECBRate[] {
  if (csvText.trim() === "") {
    return [];
  }

  const lines = csvText.split("\n");
  const headers = lines[0].split(",");
  const currencyIdx = headers.indexOf("CURRENCY");
  const timePeriodIdx = headers.indexOf("TIME_PERIOD");
  const obsValueIdx = headers.indexOf("OBS_VALUE");

  if (currencyIdx === -1 || timePeriodIdx === -1 || obsValueIdx === -1) {
    throw new Error(
      `ECB CSV missing required columns. Headers: ${headers.join(", ")}`,
    );
  }

  const rates: ECBRate[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const currency = cols[currencyIdx];
    const timePeriod = cols[timePeriodIdx];
    const obsValue = cols[obsValueIdx];
    if (!obsValue) continue;
    const rateEur = Number(obsValue);
    if (Number.isNaN(rateEur)) {
      throw new Error(
        `Invalid rate value from ECB: currency=${currency} date=${timePeriod} value=${JSON.stringify(obsValue)}`,
      );
    }
    rates.push({ currency, rate_date: timePeriod, rate_eur: rateEur });
  }
  return rates;
}

/**
 * Convert EUR-based ECB rates to base_currency/USD pairs.
 *
 * ECB gives: 1 EUR = X units of CCY (rate_eur_ccy)
 * ECB gives: 1 EUR = Y USD (rate_eur_usd)
 *
 * We produce rows with quote_currency=USD:
 * - EUR->USD: rate = rate_eur_usd
 * - CCY->USD: rate = rate_eur_usd / rate_eur_ccy
 */
function convertEurRatesToUsd(ecbRates: ECBRate[]): FxRawRateRow[] {
  const ratesByDate: Record<string, Record<string, number>> = {};
  for (const rate of ecbRates) {
    if (!ratesByDate[rate.rate_date]) {
      ratesByDate[rate.rate_date] = {};
    }
    ratesByDate[rate.rate_date][rate.currency] = rate.rate_eur;
  }

  const rows: FxRawRateRow[] = [];
  for (const rateDate of Object.keys(ratesByDate).sort()) {
    const dayRates = ratesByDate[rateDate];
    if (dayRates["USD"] === undefined) {
      throw new Error(
        `No EUR/USD rate from ECB for ${rateDate}. Available currencies: ${Object.keys(dayRates).sort().join(", ")}`,
      );
    }
    const eurUsd = dayRates["USD"];

    for (const currency of Object.keys(dayRates).sort()) {
      if (currency === "USD") {
        rows.push({
          base_currency: "EUR",
          quote_currency: "USD",
          rate_date: rateDate,
          rate: eurUsd.toFixed(9),
          source: SOURCE,
        });
      } else {
        const rateToUsd = eurUsd / dayRates[currency];
        rows.push({
          base_currency: currency,
          quote_currency: "USD",
          rate_date: rateDate,
          rate: rateToUsd.toFixed(9),
          source: SOURCE,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ECB API
// ---------------------------------------------------------------------------

// ECB answers one request for the whole requested range, and its cost is server-side
// query time rather than transfer: a one-year range is measured at 4-16 s and the full
// 1999-to-today history at ~122 s, almost all of it before the first byte. So the
// per-attempt timeout grows with the requested range instead of being a single fixed
// value, and the whole retry loop is bounded by ECB_TOTAL_BUDGET_MS, which leaves room
// inside the 300 s Lambda for the other five fetchers (~1 s) and the daily rebuild (~13 s).
const ECB_REQUEST_TIMEOUT_BASE_MS = 15_000;

const ECB_REQUEST_TIMEOUT_PER_DAY_MS = 20;

const ECB_REQUEST_TIMEOUT_MAX_MS = 240_000;

const ECB_TOTAL_BUDGET_MS = 240_000;

const ECB_REQUEST_ATTEMPTS = 3;

const ECB_RETRY_DELAY_MS = 1_000;

/** One HTTP attempt, classified into what the caller should do next. */
type EcbAttempt =
  | { kind: "ok"; body: string }
  | { kind: "transient"; error: Error }
  | { kind: "permanent"; error: Error };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-attempt timeout for a request covering `days` days.
 *
 * The ceiling stays inside the Lambda budget, so a full-history range still gets one
 * complete attempt, while a short daily range keeps its full retry allowance.
 */
function requestTimeoutMs(days: number): number {
  return Math.min(
    ECB_REQUEST_TIMEOUT_BASE_MS + days * ECB_REQUEST_TIMEOUT_PER_DAY_MS,
    ECB_REQUEST_TIMEOUT_MAX_MS,
  );
}

async function attemptEcbRequest(url: string, timeoutMs: number): Promise<EcbAttempt> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      return { kind: "ok", body: await response.text() };
    }
    // 5xx and 429 can clear on their own; any other 4xx is a defect in the request
    // itself (bad currency key, malformed period) that an identical retry repeats.
    const error = new Error(`ECB API error: ${response.status} ${response.statusText}`);
    if (response.status >= 500 || response.status === 429) {
      return { kind: "transient", error };
    }
    return { kind: "permanent", error };
  } catch (error) {
    // Connection failure, or the per-attempt timeout aborting the request or body read.
    return {
      kind: "transient",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Request the ECB CSV, retrying only transient failures.
 *
 * Attempt 1 always runs; a further one is started only while the elapsed time plus one
 * more timeout still fits ECB_TOTAL_BUDGET_MS, so the loop stays within that budget.
 */
async function fetchEcbCsv(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + ECB_TOTAL_BUDGET_MS;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= ECB_REQUEST_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await delay(ECB_RETRY_DELAY_MS * (attempt - 1));
      if (Date.now() + timeoutMs > deadline) {
        break;
      }
    }

    const result = await attemptEcbRequest(url, timeoutMs);
    if (result.kind === "ok") {
      return result.body;
    }
    if (result.kind === "permanent") {
      throw result.error;
    }

    lastError = result.error;
    console.warn("ECB request attempt failed", {
      url,
      attempt,
      attempts: ECB_REQUEST_ATTEMPTS,
      timeout_ms: timeoutMs,
      error: result.error.message,
    });
  }

  throw lastError ?? new Error(`ECB request failed after ${ECB_REQUEST_ATTEMPTS} attempts: ${url}`);
}

/** Fetch daily rates from ECB SDMX REST API as CSV. */
async function fetchEcbRates(
  currenciesWithUsd: string[],
  startPeriod: string,
  endPeriod: string,
): Promise<string> {
  const currencyKey = currenciesWithUsd.join("+");
  const url = `${ECB_BASE_URL}/D.${currencyKey}.EUR.SP00.A?format=csvdata&startPeriod=${startPeriod}&endPeriod=${endPeriod}`;
  const days = daysBetween(startPeriod, endPeriod) + 1;
  const timeoutMs = requestTimeoutMs(days);

  console.log("Fetching ECB rates", { url, days, timeout_ms: timeoutMs });

  return fetchEcbCsv(url, timeoutMs);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the currency list for the ECB API call.
 *
 * ECB rates are EUR-based. We always need USD in the response to convert
 * other currencies to USD. For EUR itself, we only need the USD rate.
 * Non-EUR/USD currencies are fetched directly.
 */
function determineEcbCurrencies(requested: string[]): string[] {
  const ecbCurrencies = new Set<string>(["USD"]);
  for (const ccy of requested) {
    if (ccy === "USD") {
      throw new Error("USD should not be in ECB_CURRENCIES config (it's the target)");
    }
    if (ccy !== "EUR") {
      ecbCurrencies.add(ccy);
    }
  }
  return Array.from(ecbCurrencies).sort();
}

/** Keep only rows not already covered by existing data. */
function filterNewRows(
  allRows: FxRawRateRow[],
  dateRanges: Record<string, DateRange>,
  requestedCurrencies: string[],
): FxRawRateRow[] {
  const newRows: FxRawRateRow[] = [];
  for (const row of allRows) {
    if (!requestedCurrencies.includes(row.base_currency)) {
      continue;
    }
    const existing = dateRanges[row.base_currency];
    if (!existing || row.rate_date < existing.min_date || row.rate_date > existing.max_date) {
      newRows.push(row);
    }
  }
  return newRows;
}

/** Main logic: fetch missing rates from ECB and insert into Postgres. */
export async function run(): Promise<FetcherResult> {
  const ecbCurrencies = determineEcbCurrencies(ECB_CURRENCIES);
  const dateRanges = await getRateDateRanges(ECB_CURRENCIES);

  // Only a currency without any row needs the full history; otherwise fetch forward
  // from what is already stored, so a daily run covers one or two days.
  const needsBackfill = ECB_CURRENCIES.some((c) => !(c in dateRanges));

  let start: string;
  if (needsBackfill) {
    start = ECB_EARLIEST_DATE;
  } else {
    const earliestMax = Object.values(dateRanges)
      .map((r) => r.max_date)
      .sort()[0];
    start = addDays(earliestMax, 1);
  }

  const end = todayIso();

  if (start > end) {
    console.log("All ECB rates are up to date");
    return { inserted: 0, latest_date: end, missing_currencies: [] };
  }

  const csvText = await fetchEcbRates(ecbCurrencies, start, end);
  const ecbRates = parseEcbCsv(csvText);

  if (ecbRates.length === 0) {
    // ECB published nothing in this period: a weekend, a TARGET holiday, or a run
    // before the ~16:00 CET publication. Nothing is missing and nothing is suspended,
    // so the stored coverage is reported unchanged and no warning is raised.
    console.log(`No ECB observations for period ${start} to ${end}`);
    const storedMaxDates = Object.values(dateRanges).map((r) => r.max_date).sort();
    const latestStored =
      storedMaxDates.length > 0 ? storedMaxDates[storedMaxDates.length - 1] : end;
    return { inserted: 0, latest_date: latestStored, missing_currencies: [] };
  }

  const allRows = convertEurRatesToUsd(ecbRates);

  const returnedCurrencies = new Set(allRows.map((r) => r.base_currency));
  const missing = ECB_CURRENCIES.filter((c) => !returnedCurrencies.has(c));
  if (missing.length > 0) {
    console.warn(
      `ECB did not return rates for currencies: ${missing.join(", ")} (they may be suspended)`,
    );
  }

  const newRows = filterNewRows(allRows, dateRanges, ECB_CURRENCIES);
  const inserted = await insertRows(newRows);

  const latestInserted =
    newRows.length > 0
      ? newRows.map((r) => r.rate_date).sort().reverse()[0]
      : end;

  console.log(`ECB: inserted ${inserted} rows, latest date: ${latestInserted}`);

  return { inserted, latest_date: latestInserted, missing_currencies: missing };
}
