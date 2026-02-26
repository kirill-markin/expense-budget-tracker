/**
 * Production startup validation.
 *
 * Called once by Next.js on server boot. Checks:
 * - AUTH_MODE is "none" or "proxy"
 * - AUTH_PROXY_HEADER, COGNITO_DOMAIN, COGNITO_CLIENT_ID are set when AUTH_MODE=proxy
 * - CORS_ORIGIN is set when AUTH_MODE=proxy (required for CSRF protection)
 * - Warns when AUTH_MODE=none with non-localhost HOST
 * - DATABASE_URL is set (local) or DB_HOST+DB_PASSWORD are set (proxy/ECS)
 *
 * Throws with all collected errors on misconfiguration. Skipped in dev.
 */
export const register = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const errors: Array<string> = [];

  const authMode = process.env.AUTH_MODE ?? "none";

  if (authMode !== "none" && authMode !== "proxy") {
    errors.push(`Invalid AUTH_MODE="${authMode}". Expected "none" or "proxy"`);
  }

  if (authMode === "proxy") {
    const proxyHeader = process.env.AUTH_PROXY_HEADER;
    if (proxyHeader === undefined || proxyHeader === "") {
      errors.push("AUTH_PROXY_HEADER must be set when AUTH_MODE=proxy");
    }
    const cognitoDomain = process.env.COGNITO_DOMAIN;
    if (cognitoDomain === undefined || cognitoDomain === "") {
      errors.push("COGNITO_DOMAIN must be set when AUTH_MODE=proxy");
    }
    const cognitoClientId = process.env.COGNITO_CLIENT_ID;
    if (cognitoClientId === undefined || cognitoClientId === "") {
      errors.push("COGNITO_CLIENT_ID must be set when AUTH_MODE=proxy");
    }
    const corsOrigin = process.env.CORS_ORIGIN;
    if (corsOrigin === undefined || corsOrigin === "") {
      errors.push("CORS_ORIGIN must be set when AUTH_MODE=proxy (required for CSRF protection)");
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

  if (authMode === "proxy") {
    if (!process.env.DB_HOST) errors.push("DB_HOST must be set when AUTH_MODE=proxy");
    if (!process.env.DB_PASSWORD) errors.push("DB_PASSWORD must be set when AUTH_MODE=proxy");
  } else {
    if (!process.env.DATABASE_URL) errors.push("DATABASE_URL must be set in production");
  }

  if (errors.length > 0) {
    throw new Error(
      `Startup validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
};
