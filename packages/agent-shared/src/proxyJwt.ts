/**
 * Vendor-neutral verification of an edge-issued identity token.
 *
 * An upstream proxy authenticates the user and forwards a signed JWT in a
 * configured request header. This module verifies that token against a
 * configured JWKS and turns it into an identity. Cloudflare Access,
 * oauth2-proxy, or any other gateway able to mint an RS256 token is then a
 * matter of configuration, not of code.
 */
import { JwtRsaVerifier } from "aws-jwt-verify";
import { SimpleJwksCache, type JwksCache } from "aws-jwt-verify/jwk";
import { type JwtPayload } from "aws-jwt-verify/jwt-model";

const PROXY_JWT_ENV_VAR_NAMES = [
  "AUTH_PROXY_JWT_HEADER",
  "AUTH_PROXY_JWKS_URL",
  "AUTH_PROXY_JWT_ISSUER",
  "AUTH_PROXY_JWT_AUDIENCE",
] as const;

export type ProxyJwtEnvVarName = (typeof PROXY_JWT_ENV_VAR_NAMES)[number];

/**
 * An environment-shaped record such as `process.env`: the four variables read
 * here are named and typed, while the index signature keeps the type open to
 * the rest of the environment. All four are optional to the compiler because
 * their absence is a runtime error naming each missing one, not a type error.
 */
export type ProxyJwtEnv = Readonly<Record<string, string | undefined>> &
  Readonly<Partial<Record<ProxyJwtEnvVarName, string>>>;

export type ProxyJwtConfig = Readonly<{
  headerName: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
}>;

export type ProxyJwtIdentity = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
}>;

export type ProxyJwtAuthenticator = Readonly<{
  headerName: string;
  verify: (token: string) => Promise<ProxyJwtIdentity>;
}>;

/**
 * The 401 body returned to a browser whose request carries no valid edge
 * token. Shared so the web app and the auth service answer with one sentence:
 * in this mode neither hosts a login page, and the user has to sign in at the
 * proxy instead.
 */
export const PROXY_JWT_UNAUTHORIZED_MESSAGE =
  "Unauthorized: this deployment expects an upstream authentication proxy to forward a verified identity token. Sign in through the proxy and retry.";

/** The only signature algorithm accepted from the upstream proxy. */
const ACCEPTED_ALGORITHM = "RS256";

/** Tolerated clock difference between the proxy and this app, in seconds. */
const CLOCK_SKEW_GRACE_SECONDS = 60;

const missingEnvVarMessage = (name: ProxyJwtEnvVarName): string =>
  `${name} must be set to a non-empty value when AUTH_MODE=proxy_jwt`;

const readEnvVar = (env: ProxyJwtEnv, name: ProxyJwtEnvVarName): string => {
  const value = (env[name] ?? "").trim();
  if (value === "") {
    throw new Error(missingEnvVarMessage(name));
  }
  return value;
};

/** Names every missing variable at once, for startup validation. */
export const getProxyJwtConfigErrors = (env: ProxyJwtEnv): ReadonlyArray<string> =>
  PROXY_JWT_ENV_VAR_NAMES
    .filter((name: ProxyJwtEnvVarName): boolean => (env[name] ?? "").trim() === "")
    .map(missingEnvVarMessage);

export const readProxyJwtConfig = (env: ProxyJwtEnv): ProxyJwtConfig => ({
  headerName: readEnvVar(env, "AUTH_PROXY_JWT_HEADER"),
  jwksUrl: readEnvVar(env, "AUTH_PROXY_JWKS_URL"),
  issuer: readEnvVar(env, "AUTH_PROXY_JWT_ISSUER"),
  audience: readEnvVar(env, "AUTH_PROXY_JWT_AUDIENCE"),
});

const toProxyJwtIdentity = (payload: JwtPayload): ProxyJwtIdentity => {
  const sub = payload.sub;
  if (typeof sub !== "string" || sub === "") {
    throw new Error("Proxy JWT payload is missing a non-empty sub claim");
  }
  const email = "email" in payload ? payload.email : undefined;
  if (typeof email !== "string" || email === "") {
    throw new Error("Proxy JWT payload is missing a non-empty email claim");
  }
  // The header token is the whole session in this mode: there is no cookie, no
  // refresh, and no revocation, so a token without an expiry would grant
  // permanent access. aws-jwt-verify only checks exp when the claim is present.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Proxy JWT payload is missing a numeric exp claim");
  }
  // The upstream proxy authenticated the user before minting this token, so the
  // address it asserts is verified by construction and no email_verified claim
  // is expected on the token.
  return { userId: sub, email, emailVerified: true };
};

export const createProxyJwtAuthenticator = (
  config: ProxyJwtConfig,
  jwksCache: JwksCache,
): ProxyJwtAuthenticator => {
  const verifier = JwtRsaVerifier.create(
    {
      jwksUri: config.jwksUrl,
      issuer: config.issuer,
      audience: config.audience,
      graceSeconds: CLOCK_SKEW_GRACE_SECONDS,
      customJwtCheck: ({ header }): void => {
        if (header.alg !== ACCEPTED_ALGORITHM) {
          throw new Error(
            `Proxy JWT header alg "${String(header.alg)}" is rejected: only ${ACCEPTED_ALGORITHM} is accepted`,
          );
        }
      },
    },
    { jwksCache },
  );

  return {
    headerName: config.headerName,
    verify: async (token: string): Promise<ProxyJwtIdentity> =>
      toProxyJwtIdentity(await verifier.verify(token)),
  };
};

export const createProxyJwtAuthenticatorFromEnv = (env: ProxyJwtEnv): ProxyJwtAuthenticator =>
  createProxyJwtAuthenticator(readProxyJwtConfig(env), new SimpleJwksCache());

type HeaderReader = Readonly<{ get: (name: string) => string | null }>;

/**
 * Read the token from the configured header. Cookies are never read: in this
 * mode the upstream proxy is the only identity source.
 */
export const extractProxyJwtToken = (headers: HeaderReader, headerName: string): string => {
  const token = (headers.get(headerName) ?? "").trim();
  if (token === "") {
    throw new Error(`Request carries no token in the ${headerName} header set by the upstream authentication proxy`);
  }
  return token;
};
