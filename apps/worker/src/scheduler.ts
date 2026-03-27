/**
 * Local Docker entrypoint: ingest raw FX rates and rebuild query-ready daily pairs.
 *
 * Schedule (UTC):
 *   - Full pipeline 08:00
 *
 * Usage:
 *     node dist/scheduler.js
 */

import cron from "node-cron";
import { run as runEcb } from "./fetchers/ecb";
import { run as runCbr } from "./fetchers/cbr";
import { run as runNbs } from "./fetchers/nbs";
import { run as runNbu } from "./fetchers/nbu";
import { run as runUsdt } from "./fetchers/usdt";
import { rebuildDailyRates } from "./rebuildDailyRates";

async function runFetcher(name: string, fetcherFn: () => Promise<unknown>): Promise<void> {
  console.log(`Starting ${name} fetch`);
  const result = await fetcherFn();
  console.log(`${name} result:`, JSON.stringify(result));
}

async function runDailyRebuild(): Promise<void> {
  console.log("Rebuilding daily FX pairs");
  const rebuildResult = await rebuildDailyRates();
  console.log("Daily FX rebuild result:", JSON.stringify(rebuildResult));
}

async function runAll(): Promise<void> {
  await runFetcher("ECB", runEcb);
  await runFetcher("CBR", runCbr);
  await runFetcher("NBS", runNbs);
  await runFetcher("NBU", runNbu);
  await runFetcher("USDT", runUsdt);
  await runDailyRebuild();
}

cron.schedule("0 8 * * *", () => {
  void runAll().catch((err: unknown) => {
    console.error("Scheduled FX pipeline failed:", err);
  });
}, { timezone: "UTC" });

console.log("Scheduler started. Running initial fetch...");
runAll()
  .then(() => {
    console.log("Initial fetch and FX rebuild complete. Entering daily schedule loop (08:00 UTC)");
  })
  .catch((err: unknown) => {
    console.error("Initial fetch failed:", err);
    process.exit(1);
  });
