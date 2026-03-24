/**
 * Production startup validation.
 *
 * Called once by Next.js on server boot. Checks:
 * - AUTH_MODE is set explicitly to "none" or "cognito"
 * - COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_REGION are set when AUTH_MODE=cognito
 * - CORS_ORIGIN is set when AUTH_MODE=cognito (required for CSRF protection)
 * - AUTH_DOMAIN is set when AUTH_MODE=cognito (auth service subdomain)
 * - AUTH_MODE=none is allowed only for explicit local dev/test
 * - DATABASE_URL is set (local) or DB_HOST+DB_PASSWORD are set (cognito/ECS)
 * - LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL are either all set or all absent
 *
 * Throws with all collected errors on misconfiguration. Skipped in dev.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getAuthModeValidationErrors } from "@/server/authMode";
import { createLangfuseSpanProcessor } from "@/server/chat/openai/langfuse";

let telemetrySdk: NodeSDK | null = null;
let telemetryStarted = false;

const validateLangfuseConfig = (): ReadonlyArray<string> => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  const presentCount = [publicKey, secretKey, baseUrl]
    .filter((value) => value !== undefined && value !== "")
    .length;

  if (presentCount === 0 || presentCount === 3) {
    return [];
  }

  return [
    "LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL must be configured together",
  ];
};

const startTelemetryIfConfigured = (): void => {
  if (telemetryStarted) {
    return;
  }

  const spanProcessor = createLangfuseSpanProcessor();
  if (spanProcessor === null) {
    return;
  }

  telemetrySdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });
  void telemetrySdk.start();
  telemetryStarted = true;
};

export const register = (): void => {
  if (process.env.NODE_ENV !== "production") return;

  const errors = Array.from(getAuthModeValidationErrors(process.env));
  const authMode = process.env.AUTH_MODE;

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

  if (authMode === "cognito") {
    if (!process.env.DB_HOST) errors.push("DB_HOST must be set when AUTH_MODE=cognito");
    if (!process.env.DB_PASSWORD) errors.push("DB_PASSWORD must be set when AUTH_MODE=cognito");
  } else {
    if (!process.env.DATABASE_URL) errors.push("DATABASE_URL must be set in production");
  }

  errors.push(...validateLangfuseConfig());

  if (errors.length > 0) {
    throw new Error(
      `Startup validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  startTelemetryIfConfigured();
};
