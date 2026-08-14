import { getOAuthConfig } from "./oauth/core.js";

export const validateAuthEnvironment = (): void => {
  const errors: Array<string> = [];
  if (!process.env.COGNITO_CLIENT_ID) errors.push("COGNITO_CLIENT_ID");
  if (!process.env.COGNITO_USER_POOL_ID) errors.push("COGNITO_USER_POOL_ID");
  if (!process.env.COGNITO_REGION) errors.push("COGNITO_REGION");
  if (!process.env.SESSION_ENCRYPTION_KEY) errors.push("SESSION_ENCRYPTION_KEY");
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
  if (errors.length > 0) {
    throw new Error(`Auth service missing required env vars: ${errors.join(", ")}`);
  }
  getOAuthConfig();
};
