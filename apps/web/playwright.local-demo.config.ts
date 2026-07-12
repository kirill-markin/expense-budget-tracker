import { defineConfig } from "@playwright/test";

const localBaseUrl = "http://localhost:3210";

export default defineConfig({
  testDir: "./e2e-local",
  testMatch: "**/*.local-demo.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: localBaseUrl,
    browserName: "chromium",
    headless: true,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `AUTH_MODE=none CORS_ORIGIN=${localBaseUrl} npm run dev -- -H 127.0.0.1 -p 3210`,
    url: localBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
