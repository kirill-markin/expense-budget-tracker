/**
 * Configuration for exchange rate fetcher worker.
 *
 * Database URL is resolved from environment:
 * - Docker/EC2: reads DATABASE_URL directly.
 * - Lambda: fetches credentials from Secrets Manager using DB_SECRET_ARN,
 *   then constructs the URL from DB_HOST and DB_NAME.
 *
 * API URLs and currency lists are defined here.
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

let resolvedDatabaseUrl: string | undefined;

export async function getDatabaseUrl(): Promise<string> {
  if (resolvedDatabaseUrl) return resolvedDatabaseUrl;

  const secretArn = process.env.DB_SECRET_ARN;
  if (secretArn) {
    const client = new SecretsManagerClient({});
    const resp = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const secret: { username: string; password: string } = JSON.parse(resp.SecretString!);
    const host = process.env.DB_HOST!;
    const dbName = process.env.DB_NAME!;
    resolvedDatabaseUrl = `postgresql://${secret.username}:${encodeURIComponent(secret.password)}@${host}:5432/${dbName}`;
  } else {
    resolvedDatabaseUrl = process.env.DATABASE_URL!;
  }

  return resolvedDatabaseUrl;
}

// ---------------------------------------------------------------------------
// ECB (European Central Bank)
// ---------------------------------------------------------------------------

// Currencies to fetch from ECB (converted to USD).
// USD is the target — no rate needed (implicit 1.0).
// RUB is fetched separately via CBR (ECB suspended RUB since March 2022).
// RSD is fetched separately via NBS (National Bank of Serbia).
export const ECB_CURRENCIES: string[] = ["BGN", "EUR", "GBP", "TRY"];

export const ECB_EARLIEST_DATE: string = "1999-01-04";

export const ECB_BASE_URL: string = "https://data-api.ecb.europa.eu/service/data/EXR";

// ---------------------------------------------------------------------------
// CBR (Bank of Russia)
// ---------------------------------------------------------------------------

// Bank of Russia internal ID for USD.
// Full list: https://www.cbr.ru/scripts/XML_valFull.asp
export const CBR_USD_ID: string = "R01235";

export const CBR_EARLIEST_DATE: string = "1992-07-01";

export const CBR_BASE_URL: string = "https://www.cbr.ru/scripts/XML_dynamic.asp";

// ---------------------------------------------------------------------------
// NBS (National Bank of Serbia)
// ---------------------------------------------------------------------------

// Kurs API — free JSON wrapper around official National Bank of Serbia rates.
// Docs: https://kurs.resenje.org/doc/
export const NBS_API_BASE_URL: string = "https://kurs.resenje.org/api/v1";

// Maximum number of daily rates per single API request.
export const NBS_EARLIEST_DATE: string = "2003-01-01";

export const NBS_MAX_COUNT: number = 1000;

// ---------------------------------------------------------------------------
// NBU (National Bank of Ukraine)
// ---------------------------------------------------------------------------

// National Bank of Ukraine — official exchange rates API.
// Docs: https://bank.gov.ua/en/open-data/api-dev
export const NBU_EARLIEST_DATE: string = "1996-01-06";

export const NBU_BASE_URL: string = "https://bank.gov.ua/NBU_Exchange/exchange_site";
