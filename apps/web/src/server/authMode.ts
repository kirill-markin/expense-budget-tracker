import { getProxyJwtConfigErrors, type ProxyJwtEnv } from "@expense-budget-tracker/agent-shared/proxy-jwt";

export type AuthMode = "none" | "cognito" | "proxy_jwt";

type AuthModeEnv = ProxyJwtEnv & Readonly<{
  AUTH_MODE?: string;
  NODE_ENV?: string;
  HOST?: string;
  CORS_ORIGIN?: string;
  ALLOW_INSECURE_NO_AUTH?: string;
}>;

const ACCEPTED_AUTH_MODES = '"none", "cognito", or "proxy_jwt"';
const AUTH_MODE_REQUIRED_MESSAGE = `AUTH_MODE must be set explicitly to ${ACCEPTED_AUTH_MODES}`;

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

/**
 * Opt-in flag for a deliberately unauthenticated deployment, such as the local
 * Docker stack published on loopback only. It relaxes exactly the two checks a
 * container cannot satisfy — a production build and a 0.0.0.0 bind — and has no
 * effect unless AUTH_MODE=none. Only the exact value "true" opts in: spelling
 * variants and surrounding whitespace are rejected.
 */
export const isInsecureNoAuthAllowed = (env: AuthModeEnv): boolean =>
  env.ALLOW_INSECURE_NO_AUTH === "true";

const normalizeHost = (value: string): string =>
  value.replace(/^\[(.*)\]$/u, "$1").trim().toLowerCase();

const isLocalHost = (value: string): boolean =>
  LOCAL_HOSTS.has(normalizeHost(value));

const isLocalHttpOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLocalHost(url.hostname);
  } catch {
    return false;
  }
};

/**
 * True only for a bare absolute origin such as "https://tracker.example.com":
 * a parseable URL whose own origin is exactly the value, which rejects a bare
 * host, a trailing slash, and anything carrying a path, query, or fragment.
 */
const isAbsoluteOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

export const getAuthModeValidationErrors = (env: AuthModeEnv): ReadonlyArray<string> => {
  const rawAuthMode = env.AUTH_MODE;
  if (rawAuthMode === undefined || rawAuthMode.trim() === "") {
    return [AUTH_MODE_REQUIRED_MESSAGE];
  }

  if (rawAuthMode !== "none" && rawAuthMode !== "cognito" && rawAuthMode !== "proxy_jwt") {
    return [`Invalid AUTH_MODE="${rawAuthMode}". Expected ${ACCEPTED_AUTH_MODES}`];
  }

  if (rawAuthMode === "cognito") {
    return [];
  }

  // proxy_jwt delegates authentication to an upstream proxy, so it constrains
  // neither NODE_ENV nor HOST: the app is meant to be reachable behind it.
  // CORS_ORIGIN is still required, in any scheme or host: behind a proxy the
  // request URL is the internal container address, so HSTS, the CSRF origin
  // check, and every generated public link depend on the configured origin.
  // Only its shape is constrained, because a value that is not an absolute
  // origin silently breaks all three at request time instead of at startup.
  // The shape check runs on the untrimmed value, because the consumers in
  // proxy.ts compare process.env.CORS_ORIGIN verbatim: surrounding whitespace
  // would never match a request Origin and would defeat the https check.
  if (rawAuthMode === "proxy_jwt") {
    const proxyErrors = [...getProxyJwtConfigErrors(env)];
    const corsOrigin = env.CORS_ORIGIN ?? "";
    if (corsOrigin.trim() === "") {
      proxyErrors.push(
        "AUTH_MODE=proxy_jwt requires CORS_ORIGIN to be set to the public origin the upstream proxy serves",
      );
    } else if (!isAbsoluteOrigin(corsOrigin)) {
      proxyErrors.push(
        `AUTH_MODE=proxy_jwt requires CORS_ORIGIN to be an absolute origin with a scheme and no trailing slash or path, such as "https://tracker.example.com". Received "${corsOrigin}"`,
      );
    }
    return proxyErrors;
  }

  const errors: Array<string> = [];
  const insecureNoAuthAllowed = isInsecureNoAuthAllowed(env);

  if (!insecureNoAuthAllowed) {
    if (env.NODE_ENV === "production") {
      errors.push(
        "AUTH_MODE=none is not allowed when NODE_ENV=production. Set ALLOW_INSECURE_NO_AUTH=true to run an unauthenticated deployment on purpose",
      );
    }

    const host = env.HOST ?? "127.0.0.1";
    if (!isLocalHost(host)) {
      errors.push(
        `AUTH_MODE=none requires HOST to be localhost, 127.0.0.1, or ::1. Received "${host}". Set ALLOW_INSECURE_NO_AUTH=true to run an unauthenticated deployment on purpose`,
      );
    }
  }

  const corsOrigin = env.CORS_ORIGIN;
  if (corsOrigin === undefined || corsOrigin.trim() === "") {
    errors.push("AUTH_MODE=none requires CORS_ORIGIN to be set to a local http origin");
  } else if (!isLocalHttpOrigin(corsOrigin)) {
    errors.push(
      `AUTH_MODE=none requires CORS_ORIGIN to be a local http origin (localhost, 127.0.0.1, or ::1). Received "${corsOrigin}"`,
    );
  }

  return errors;
};

export const getConfiguredAuthMode = (env: AuthModeEnv): AuthMode => {
  const errors = getAuthModeValidationErrors(env);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const authMode = env.AUTH_MODE;
  if (authMode === "none" || authMode === "cognito" || authMode === "proxy_jwt") {
    return authMode;
  }

  throw new Error(AUTH_MODE_REQUIRED_MESSAGE);
};
