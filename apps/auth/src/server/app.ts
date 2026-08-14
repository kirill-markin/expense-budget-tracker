import { Hono } from "hono";
import health from "../routes/health.js";
import sendCode from "../routes/sendCode.js";
import verifyCode from "../routes/verifyCode.js";
import agentSendCode from "../routes/agentSendCode.js";
import agentVerifyCode from "../routes/agentVerifyCode.js";
import loginPage from "../routes/loginPage.js";
import robots from "../routes/robots.js";
import oauth from "../routes/oauth.js";
import { getSafeErrorType, log, type AuthUnhandledErrorEvent } from "./logger.js";

export type AuthAppDependencies = Readonly<{
  routes: ReadonlyArray<Hono>;
  log: (event: AuthUnhandledErrorEvent) => void;
}>;

const getErrorSurface = (path: string): AuthUnhandledErrorEvent["surface"] => {
  if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/oauth/")) return "oauth";
  if (path === "/login") return "login";
  if (path.startsWith("/api/")) return "api";
  return "other";
};

const getErrorMethod = (method: string): AuthUnhandledErrorEvent["method"] => {
  if (method === "GET" || method === "POST" || method === "OPTIONS") return method;
  return "OTHER";
};

export const createAuthApp = (dependencies: AuthAppDependencies): Hono => {
  const app = new Hono();

  app.onError((error, c) => {
    dependencies.log({
      domain: "auth",
      action: "unhandled_error",
      surface: getErrorSurface(c.req.path),
      method: getErrorMethod(c.req.method),
      errorType: getSafeErrorType(error),
    });
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json({ error: "Internal server error" }, 500);
  });

  // API endpoints are same-origin only; login-page JavaScript is their browser caller.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204 });
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return c.json({ error: "Cross-origin requests not allowed" }, 403);
    }
    await next();
  });

  for (const route of dependencies.routes) app.route("/", route);
  return app;
};

export const createDefaultAuthApp = (): Hono => createAuthApp({
  routes: [health, sendCode, verifyCode, agentSendCode, agentVerifyCode, loginPage, robots, oauth],
  log,
});
