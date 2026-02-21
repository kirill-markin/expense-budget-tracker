/**
 * Local Docker entrypoint: run exchange rate fetchers on a daily schedule.
 *
 * Schedule (UTC):
 *   - ECB  08:00
 *   - CBR  08:05
 *   - NBS  08:10
 *
 * Usage:
 *     node dist/scheduler.js
 */

import cron from "node-cron";
import { run as runEcb } from "./fetchers/ecb";
import { run as runCbr } from "./fetchers/cbr";
import { run as runNbs } from "./fetchers/nbs";

async function runFetcher(name: string, fetcherFn: () => Promise<unknown>): Promise<void> {
  console.log(`Starting ${name} fetch`);
  const result = await fetcherFn();
  console.log(`${name} result:`, JSON.stringify(result));
}

async function runAll(): Promise<void> {
  await runFetcher("ECB", runEcb);
  await runFetcher("CBR", runCbr);
  await runFetcher("NBS", runNbs);
}

cron.schedule("0 8 * * *", () => { runFetcher("ECB", runEcb); }, { timezone: "UTC" });
cron.schedule("5 8 * * *", () => { runFetcher("CBR", runCbr); }, { timezone: "UTC" });
cron.schedule("10 8 * * *", () => { runFetcher("NBS", runNbs); }, { timezone: "UTC" });

console.log("Scheduler started. Running initial fetch...");
runAll()
  .then(() => {
    console.log("Initial fetch complete. Entering schedule loop (ECB 08:00, CBR 08:05, NBS 08:10 UTC)");
  })
  .catch((err: unknown) => {
    console.error("Initial fetch failed:", err);
    process.exit(1);
  });
