/**
 * Auth service entry point.
 *
 * Standalone Hono service for email OTP authentication via Cognito and MCP OAuth.
 * Handles login, OTP send/verify, public-client registration, consent, and
 * tokens. Sets session cookies with Domain=COOKIE_DOMAIN so they're visible
 * on app.*.
 * Runs on its own subdomain (auth.*), separate from the main web app.
 */
import { serve } from "@hono/node-server";
import { createDefaultAuthApp } from "./server/app.js";
import { validateAuthEnvironment } from "./server/config.js";

validateAuthEnvironment();

const app = createDefaultAuthApp();

const port = parseInt(process.env.PORT ?? "8081", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ domain: "auth", action: "start", port: info.port }));
});
