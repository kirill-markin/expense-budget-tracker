/**
 * AWS Lambda entrypoint for exchange rate fetchers.
 *
 * Invoked by EventBridge schedule rules. Runs all fetchers sequentially
 * against the Postgres database specified by DATABASE_URL.
 */

import { run as runEcb } from "./fetchers/ecb";
import { run as runCbr } from "./fetchers/cbr";
import { run as runNbs } from "./fetchers/nbs";
import { run as runNbu } from "./fetchers/nbu";
import { endPool } from "./db";

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    const results = {
      ecb: await runEcb(),
      cbr: await runCbr(),
      nbs: await runNbs(),
      nbu: await runNbu(),
    };

    console.log("All fetchers complete:", JSON.stringify(results));

    return {
      statusCode: 200,
      body: JSON.stringify(results),
    };
  } finally {
    await endPool();
  }
}
