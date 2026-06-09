import {
  defineConfig,
  type ScreenshotMode,
  type TraceMode,
  type VideoMode,
} from "@playwright/test";

const appBaseUrl = process.env.EXPENSE_E2E_APP_BASE_URL ?? "https://app.expense-budget-tracker.com";

const defaultTraceMode: TraceMode = "retain-on-failure";
const defaultVideoMode: VideoMode = "retain-on-failure";
const defaultScreenshotMode: ScreenshotMode = "only-on-failure";
const liveSmokeNavigationTimeoutMs: number = 60_000;
const liveSmokeWorkerCount: number = 1;
const ciRetryCount: number = process.env.CI === "true" ? 1 : 0;

const traceModeValues = new Set<TraceMode>([
  "off",
  "on",
  "retain-on-failure",
  "on-first-retry",
  "on-all-retries",
  "retain-on-first-failure",
  "retain-on-failure-and-retries",
]);
const videoModeValues = new Set<VideoMode>(["off", "on", "retain-on-failure", "on-first-retry"]);
const screenshotModeValues = new Set<ScreenshotMode>(["off", "on", "only-on-failure", "on-first-failure"]);

const readTraceMode = (): TraceMode => {
  const rawValue = process.env.EXPENSE_E2E_TRACE_MODE;
  if (rawValue === undefined) {
    return defaultTraceMode;
  }

  if (traceModeValues.has(rawValue as TraceMode)) {
    return rawValue as TraceMode;
  }

  throw new Error(
    `Invalid EXPENSE_E2E_TRACE_MODE: ${rawValue}. Expected one of: ${Array.from(traceModeValues).join(", ")}`,
  );
};

const readVideoMode = (): VideoMode => {
  const rawValue = process.env.EXPENSE_E2E_VIDEO_MODE;
  if (rawValue === undefined) {
    return defaultVideoMode;
  }

  if (videoModeValues.has(rawValue as VideoMode)) {
    return rawValue as VideoMode;
  }

  throw new Error(
    `Invalid EXPENSE_E2E_VIDEO_MODE: ${rawValue}. Expected one of: ${Array.from(videoModeValues).join(", ")}`,
  );
};

const readScreenshotMode = (): ScreenshotMode => {
  const rawValue = process.env.EXPENSE_E2E_SCREENSHOT_MODE;
  if (rawValue === undefined) {
    return defaultScreenshotMode;
  }

  if (screenshotModeValues.has(rawValue as ScreenshotMode)) {
    return rawValue as ScreenshotMode;
  }

  throw new Error(
    `Invalid EXPENSE_E2E_SCREENSHOT_MODE: ${rawValue}. Expected one of: ${Array.from(screenshotModeValues).join(", ")}`,
  );
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 10 * 60 * 1000,
  fullyParallel: false,
  workers: liveSmokeWorkerCount,
  retries: ciRetryCount,
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
    navigationTimeout: liveSmokeNavigationTimeoutMs,
    trace: readTraceMode(),
    screenshot: readScreenshotMode(),
    video: readVideoMode(),
  },
});
