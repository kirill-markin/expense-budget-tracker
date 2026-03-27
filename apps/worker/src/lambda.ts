/**
 * AWS Lambda entrypoint for the FX pipeline.
 *
 * Invoked by EventBridge schedule rules. It ingests raw source rates first and
 * then rebuilds the query-ready all-pairs daily FX table in one coherent pass.
 */

import { run as runEcb } from "./fetchers/ecb";
import { run as runCbr } from "./fetchers/cbr";
import { run as runNbs } from "./fetchers/nbs";
import { run as runNbu } from "./fetchers/nbu";
import { run as runUsdt } from "./fetchers/usdt";
import { endPool } from "./db";
import { rebuildDailyRates } from "./rebuildDailyRates";
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

    const rebuildResult = await rebuildDailyRates();
    console.log("Daily FX rebuild complete:", JSON.stringify(rebuildResult));

    return {
      statusCode: 200,
      body: JSON.stringify({
        fetchers: results,
        rebuild: rebuildResult,
      }),
    };
  } finally {
    await endPool();
  }
}
