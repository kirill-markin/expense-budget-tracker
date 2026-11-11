/**
 * Production startup validation.
 *
 * Called once by Next.js on server boot. Checks:
 * - AUTH_MODE is set explicitly to "none", "cognito", or "proxy_jwt"
 * - COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_REGION are set when AUTH_MODE=cognito
 * - CORS_ORIGIN is set when AUTH_MODE=cognito (required for CSRF protection)
 * - AUTH_DOMAIN is set when AUTH_MODE=cognito (auth service subdomain)
 * - AUTH_PROXY_JWT_HEADER, AUTH_PROXY_JWKS_URL, AUTH_PROXY_JWT_ISSUER,
 *   AUTH_PROXY_JWT_AUDIENCE and CORS_ORIGIN are set when AUTH_MODE=proxy_jwt
 * - AUTH_MODE=none is allowed only for explicit local dev/test, or for a
 *   deployment that opts in with ALLOW_INSECURE_NO_AUTH=true
 * - DATABASE_URL is set (local) or DB_HOST+DB_PASSWORD are set (cognito/ECS)
 * - LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL are either all set or all absent
 * - LANGFUSE_RELEASE is an explicit release fingerprint when Langfuse telemetry is enabled
 *
 * Throws with all collected errors on misconfiguration. Skipped in dev.
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getAuthModeValidationErrors, isInsecureNoAuthAllowed } from "@/server/authMode";
import { createLangfuseSpanProcessor } from "@/server/chat/openai/langfuse";
import { getDatabaseConnectionSettings } from "@/server/db/connectionSettings";
import { log } from "@/server/logger";
import { createOwnTracerSpanProcessor } from "@/server/telemetry/ownTracerSpanProcessor";
import { PostgresSpanExporter } from "@/server/telemetry/postgresSpanExporter";

let telemetrySdk: NodeSDK | null = null;
let telemetryStarted = false;

type LangfuseEnvironment = Readonly<{
  [name: string]: string | undefined;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_RELEASE?: string;
}>;

export const getLangfuseConfigValidationErrors = (
  environment: LangfuseEnvironment,
): ReadonlyArray<string> => {
  const connectionValues = [
    environment.LANGFUSE_PUBLIC_KEY,
    environment.LANGFUSE_SECRET_KEY,
    environment.LANGFUSE_BASE_URL,
  ];
  const connectionSettingsAbsent = connectionValues.every(
    (value) => value === undefined || value === "",
  );
  if (connectionSettingsAbsent) {
    return [];
  }

  const errors: Array<string> = [];
  if (connectionValues.some((value) => value === undefined || value.trim() === "")) {
    errors.push(
      "LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL must be configured together with non-empty values",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(environment.LANGFUSE_RELEASE ?? "")) {
    errors.push(
      "LANGFUSE_RELEASE must be an explicit 64-character lowercase hexadecimal release fingerprint when Langfuse telemetry is enabled",
    );
  }

  return errors;
};

type OtlpEnvironment = Readonly<{
  [name: string]: string | undefined;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
}>;

const isOtlpTraceExportConfigured = (environment: OtlpEnvironment): boolean =>
  [environment.OTEL_EXPORTER_OTLP_ENDPOINT, environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT].some(
    (value) => value !== undefined && value !== "",
  );

const createSpanProcessors = (): ReadonlyArray<SpanProcessor> => {
  // A full queue drops new spans rather than holding back the chat that ends
  // them, so only spans of our own tracer may take its slots.
  const processors: Array<SpanProcessor> = [
    createOwnTracerSpanProcessor(
      new BatchSpanProcessor(new PostgresSpanExporter(getDatabaseConnectionSettings(process.env)), {
        maxQueueSize: 2048,
        maxExportBatchSize: 256,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 10000,
      }),
    ),
  ];
  // The exporter reads the endpoint, headers and other OTEL_EXPORTER_OTLP_* settings itself.
  if (isOtlpTraceExportConfigured(process.env)) {
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }
  const langfuseSpanProcessor = createLangfuseSpanProcessor();
  if (langfuseSpanProcessor !== null) {
    processors.push(langfuseSpanProcessor);
  }
  return processors;
};

const startTelemetry = (): void => {
  if (telemetryStarted) {
    return;
  }

  // Traces only: without the empty lists NodeSDK also starts OTLP metric and
  // log pipelines aimed at the default localhost endpoint.
  telemetrySdk = new NodeSDK({
    serviceName: "expense-budget-tracker-web",
    spanProcessors: [...createSpanProcessors()],
    metricReaders: [],
    logRecordProcessors: [],
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

  errors.push(...getLangfuseConfigValidationErrors(process.env));

  if (errors.length > 0) {
    throw new Error(
      `Startup validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }

  if (authMode === "none" && isInsecureNoAuthAllowed(process.env)) {
    log({
      domain: "auth",
      action: "insecure_no_auth",
      message:
        "ALLOW_INSECURE_NO_AUTH=true with AUTH_MODE=none: this instance serves every request unauthenticated. Expose it on loopback only.",
    });
  }

  startTelemetry();
};
