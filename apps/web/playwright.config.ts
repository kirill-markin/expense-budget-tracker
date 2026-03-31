import { defineConfig } from "@playwright/test";

const appBaseUrl = process.env.EXPENSE_E2E_APP_BASE_URL ?? "https://app.expense-budget-tracker.com";

export default defineConfig({
  testDir: "./e2e",
  timeout: 10 * 60 * 1000,
  fullyParallel: false,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["junit", { outputFile: "test-results/e2e-results.xml" }],
  ],
  use: {
    baseURL: appBaseUrl,
    actionTimeout: 10_000,
    browserName: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    navigationTimeout: 30_000,
    trace: "on",
    screenshot: "on",
    video: "on",
  },
});
