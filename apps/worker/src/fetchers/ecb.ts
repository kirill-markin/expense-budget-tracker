/**
 * Fetch daily exchange rates from ECB and insert into Postgres.
 *
 * Fetches EUR-based rates from the ECB SDMX REST API, converts to
 * base_currency/quote_currency/rate pairs (quote_currency=USD),
 * and inserts missing dates into exchange_rates.
 */

import { ECB_BASE_URL, ECB_CURRENCIES, ECB_EARLIEST_DATE } from "../config";
import { addDays, todayIso } from "../dateUtils";
import { getRateDateRanges, insertRows } from "../dbQueries";
import type { ExchangeRateRow, DateRange, FetcherResult } from "../types";

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
 */
function parseEcbCsv(csvText: string): ECBRate[] {
  const lines = csvText.split("\n");
  if (lines.length === 0) {
    return [];
  }

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
function convertEurRatesToUsd(ecbRates: ECBRate[]): ExchangeRateRow[] {
  const ratesByDate: Record<string, Record<string, number>> = {};
  for (const rate of ecbRates) {
    if (!ratesByDate[rate.rate_date]) {
      ratesByDate[rate.rate_date] = {};
    }
    ratesByDate[rate.rate_date][rate.currency] = rate.rate_eur;
  }

  const rows: ExchangeRateRow[] = [];
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
        });
      } else {
        const rateToUsd = eurUsd / dayRates[currency];
        rows.push({
          base_currency: currency,
          quote_currency: "USD",
          rate_date: rateDate,
          rate: rateToUsd.toFixed(9),
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ECB API
// ---------------------------------------------------------------------------

/** Fetch daily rates from ECB SDMX REST API as CSV. */
async function fetchEcbRates(
  currenciesWithUsd: string[],
  startPeriod: string,
  endPeriod: string,
): Promise<string> {
  const currencyKey = currenciesWithUsd.join("+");
  const url = `${ECB_BASE_URL}/D.${currencyKey}.EUR.SP00.A?format=csvdata&startPeriod=${startPeriod}&endPeriod=${endPeriod}`;

  console.log("Fetching ECB rates", { url });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ECB API error: ${response.status} ${response.statusText}`);
  }
  return response.text();
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
  allRows: ExchangeRateRow[],
  dateRanges: Record<string, DateRange>,
  requestedCurrencies: string[],
): ExchangeRateRow[] {
  const newRows: ExchangeRateRow[] = [];
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

  const allCurrenciesPresent = ECB_CURRENCIES.every((c) => c in dateRanges);
  const needsBackfill =
    !allCurrenciesPresent ||
    Object.values(dateRanges).some((r) => r.min_date > ECB_EARLIEST_DATE);

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
