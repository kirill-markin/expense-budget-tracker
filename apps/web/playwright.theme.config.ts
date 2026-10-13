import { defineConfig } from "@playwright/test";

const baseURL = "http://localhost:3211";

// Exercise the initial theme script under the production Content Security Policy.
// Build first with npm run test:e2e:theme.
export default defineConfig({
  testDir: "./e2e-local",
  testMatch: "**/theme.local-demo.spec.ts",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run start",
    env: {
      AUTH_MODE: "none",
      ALLOW_INSECURE_NO_AUTH: "true",
      // Tests set the demo cookie; the production startup validator still needs a URL.
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      CORS_ORIGIN: baseURL,
      HOST: "127.0.0.1",
      PORT: "3211",
    },
    url: `${baseURL}/api/live`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
