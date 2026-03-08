/**
 * Auth service entry point.
 *
 * Standalone Hono service for email OTP authentication via Cognito.
 * Handles login page, OTP send/verify. Sets session cookies with
 * Domain=COOKIE_DOMAIN so they're visible on app.*.
 * Runs on its own subdomain (auth.*), separate from the main web app.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import health from "./routes/health.js";
import sendCode from "./routes/sendCode.js";
import verifyCode from "./routes/verifyCode.js";
import loginPage from "./routes/loginPage.js";
import robots from "./routes/robots.js";

const validateEnv = (): void => {
  const errors: Array<string> = [];
  if (!process.env.COGNITO_CLIENT_ID) errors.push("COGNITO_CLIENT_ID");
  if (!process.env.COGNITO_REGION) errors.push("COGNITO_REGION");
  if (!process.env.SESSION_ENCRYPTION_KEY) errors.push("SESSION_ENCRYPTION_KEY");
  if (!process.env.ALLOWED_REDIRECT_URIS) errors.push("ALLOWED_REDIRECT_URIS");
  if (!process.env.COOKIE_DOMAIN) errors.push("COOKIE_DOMAIN");
  if (errors.length > 0) {
    throw new Error(`Auth service missing required env vars: ${errors.join(", ")}`);
  }
};

if (process.env.NODE_ENV !== "development") {
  validateEnv();
}

const app = new Hono();

// Deny cross-origin requests to API endpoints (defense-in-depth).
// The login page JS makes same-origin fetches; cross-origin callers have
// no legitimate reason to hit these endpoints.
app.use("/api/*", async (c, next) => {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  const secFetchSite = c.req.header("sec-fetch-site");
  if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return c.json({ error: "Cross-origin requests not allowed" }, 403);
  }
  await next();
});

app.route("/", health);
app.route("/", sendCode);
app.route("/", verifyCode);
app.route("/", loginPage);
app.route("/", robots);

const port = parseInt(process.env.PORT ?? "8081", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ domain: "auth", action: "start", port: info.port }));
});
