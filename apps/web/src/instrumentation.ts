/**
 * Production startup validation.
 *
 * Called once by Next.js on server boot. Checks:
 * - AUTH_MODE is "none" or "cognito"
 * - COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_REGION are set when AUTH_MODE=cognito
 * - CORS_ORIGIN is set when AUTH_MODE=cognito (required for CSRF protection)
 * - AUTH_DOMAIN is set when AUTH_MODE=cognito (auth service subdomain)
 * - Warns when AUTH_MODE=none with non-localhost HOST
 * - DATABASE_URL is set (local) or DB_HOST+DB_PASSWORD are set (cognito/ECS)
 *
 * Throws with all collected errors on misconfiguration. Skipped in dev.
 */
export const register = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const errors: Array<string> = [];

  const authMode = process.env.AUTH_MODE ?? "none";

  if (authMode !== "none" && authMode !== "cognito") {
    errors.push(`Invalid AUTH_MODE="${authMode}". Expected "none" or "cognito"`);
  }

  if (authMode === "cognito") {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (userPoolId === undefined || userPoolId === "") {
      errors.push("COGNITO_USER_POOL_ID must be set when AUTH_MODE=cognito");
    }
    const cognitoClientId = process.env.COGNITO_CLIENT_ID;
    if (cognitoClientId === undefined || cognitoClientId === "") {
      errors.push("COGNITO_CLIENT_ID must be set when AUTH_MODE=cognito");
    }
    const cognitoRegion = process.env.COGNITO_REGION;
    if (cognitoRegion === undefined || cognitoRegion === "") {
      errors.push("COGNITO_REGION must be set when AUTH_MODE=cognito");
    }
    const corsOrigin = process.env.CORS_ORIGIN;
    if (corsOrigin === undefined || corsOrigin === "") {
      errors.push("CORS_ORIGIN must be set when AUTH_MODE=cognito (required for CSRF protection)");
    }
    const authDomain = process.env.AUTH_DOMAIN;
    if (authDomain === undefined || authDomain === "") {
      errors.push("AUTH_DOMAIN must be set when AUTH_MODE=cognito (auth service subdomain)");
    }
  }

  if (authMode === "none") {
    const host = process.env.HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.warn(
        `WARNING: AUTH_MODE=none with HOST=${host}. The app has no authentication and should only bind to localhost`,
      );
    }
  }

  if (authMode === "cognito") {
    if (!process.env.DB_HOST) errors.push("DB_HOST must be set when AUTH_MODE=cognito");
    if (!process.env.DB_PASSWORD) errors.push("DB_PASSWORD must be set when AUTH_MODE=cognito");
  } else {
    if (!process.env.DATABASE_URL) errors.push("DATABASE_URL must be set in production");
  }

  if (errors.length > 0) {
    throw new Error(
      `Startup validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
};
