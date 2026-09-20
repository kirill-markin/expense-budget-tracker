import { getProxyJwtConfigErrors } from "@expense-budget-tracker/agent-shared/proxy-jwt";
import { getAuthServiceMode } from "./authMode.js";
import { getOAuthConfig } from "./oauth/core.js";

export const validateAuthEnvironment = (): void => {
  const authMode = getAuthServiceMode(process.env);
  const errors: Array<string> = [];
  // Cognito and the OTP session it backs are unused in proxy_jwt mode: the
  // login routes are not registered, identity comes from the edge token, and
  // the OAuth owner check reads the local identity mirror instead of the user
  // pool. Nothing in that mode reaches COGNITO_USER_POOL_ID or COGNITO_REGION
  // at runtime, so demanding them here would fail a valid deployment.
  if (authMode === "cognito") {
    if (!process.env.COGNITO_CLIENT_ID) errors.push("COGNITO_CLIENT_ID");
    if (!process.env.COGNITO_USER_POOL_ID) errors.push("COGNITO_USER_POOL_ID");
    if (!process.env.COGNITO_REGION) errors.push("COGNITO_REGION");
    if (!process.env.SESSION_ENCRYPTION_KEY) errors.push("SESSION_ENCRYPTION_KEY");
  }
  if (!process.env.ALLOWED_REDIRECT_URIS) errors.push("ALLOWED_REDIRECT_URIS");
  if (!process.env.COOKIE_DOMAIN) errors.push("COOKIE_DOMAIN");
  if (!process.env.OAUTH_ISSUER) errors.push("OAUTH_ISSUER");
  if (!process.env.OAUTH_RESOURCE) errors.push("OAUTH_RESOURCE");
  if (!(process.env.AUTH_DATABASE_URL ?? "") && !(process.env.DB_HOST ?? "")) {
    errors.push("AUTH_DATABASE_URL or DB_HOST");
  }
  if ((process.env.AUTH_DATABASE_URL ?? "") === "") {
    if (!process.env.DB_NAME) errors.push("DB_NAME");
    if (!process.env.DB_USER) errors.push("DB_USER");
    if (!process.env.DB_PASSWORD) errors.push("DB_PASSWORD");
  }
  // CORS_ORIGIN is required of the web app in proxy_jwt mode but not here: this
  // service reads no such variable, deriving its own origin from OAUTH_ISSUER
  // and validating browser redirects against ALLOWED_REDIRECT_URIS.
  const messages: Array<string> = authMode === "proxy_jwt"
    ? [...getProxyJwtConfigErrors(process.env)]
    : [];
  if (errors.length > 0) {
    messages.unshift(`Auth service missing required env vars: ${errors.join(", ")}`);
  }
  if (messages.length > 0) {
    throw new Error(messages.join("\n"));
  }
  getOAuthConfig();
};
