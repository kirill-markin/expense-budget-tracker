/**
 * Configuration for exchange rate fetcher worker.
 *
 * All database config comes from DATABASE_URL environment variable.
 * API URLs and currency lists are defined here.
 */

// Database connection string (required).
export const DATABASE_URL: string = process.env.DATABASE_URL!;

// ---------------------------------------------------------------------------
// ECB (European Central Bank)
// ---------------------------------------------------------------------------

// Currencies to fetch from ECB (converted to USD).
// USD is the target — no rate needed (implicit 1.0).
// RUB is fetched separately via CBR (ECB suspended RUB since March 2022).
// RSD is fetched separately via NBS (National Bank of Serbia).
export const ECB_CURRENCIES: string[] = ["BGN", "EUR", "GBP", "TRY"];

export const ECB_BASE_URL: string = "https://data-api.ecb.europa.eu/service/data/EXR";

// ---------------------------------------------------------------------------
// CBR (Bank of Russia)
// ---------------------------------------------------------------------------

// Bank of Russia internal ID for USD.
// Full list: https://www.cbr.ru/scripts/XML_valFull.asp
export const CBR_USD_ID: string = "R01235";

export const CBR_BASE_URL: string = "https://www.cbr.ru/scripts/XML_dynamic.asp";

// ---------------------------------------------------------------------------
// NBS (National Bank of Serbia)
// ---------------------------------------------------------------------------

// Kurs API — free JSON wrapper around official National Bank of Serbia rates.
// Docs: https://kurs.resenje.org/doc/
export const NBS_API_BASE_URL: string = "https://kurs.resenje.org/api/v1";

// Maximum number of daily rates per single API request.
export const NBS_MAX_COUNT: number = 1000;
