/**
 * AWS Lambda entrypoint for exchange rate fetchers.
 *
 * Invoked by EventBridge schedule rules. Runs all fetchers in parallel
 * against the Postgres database specified by DATABASE_URL.
 */

import { run as runEcb } from "./fetchers/ecb";
import { run as runCbr } from "./fetchers/cbr";
import { run as runNbs } from "./fetchers/nbs";
import { run as runNbu } from "./fetchers/nbu";
import { run as runUsdt } from "./fetchers/usdt";
import { endPool } from "./db";
import type { FetcherOutcome } from "./types";

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    const fetchers = [
      { name: "ecb", run: runEcb },
      { name: "cbr", run: runCbr },
      { name: "nbs", run: runNbs },
      { name: "nbu", run: runNbu },
      { name: "usdt", run: runUsdt },
    ] as const;

    const settled = await Promise.allSettled(fetchers.map((f) => f.run()));

    const results: Record<string, FetcherOutcome> = {};
    for (let i = 0; i < fetchers.length; i++) {
      const s = settled[i];
      results[fetchers[i].name] =
        s.status === "fulfilled"
          ? { status: "ok", result: s.value }
          : { status: "error", error: String(s.reason) };
    }

    const errors = Object.entries(results).filter(([, v]) => v.status === "error");
    if (errors.length > 0) {
      console.error("Fetcher errors:", JSON.stringify(Object.fromEntries(errors)));
    }
    console.log("All fetchers complete:", JSON.stringify(results));

    if (errors.length === fetchers.length) {
      throw new Error(`All fetchers failed: ${errors.map(([k]) => k).join(", ")}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify(results),
    };
  } finally {
    await endPool();
  }
}
