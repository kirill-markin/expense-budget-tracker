import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_SCOPES = ["expenses:read", "expenses:write"] as const;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/u;
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/u;
const RAW_REDIRECT_URI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~:/?@!$&'()*+,;=%\[\]-]*$/u;
const RAW_HTTPS_REDIRECT_URI_RE = /^https:\/\/[^/?]+(?:[/?].*)?$/iu;
const RAW_HTTP_REDIRECT_URI_RE = /^http:\/\/[^/?]+(?:[/?].*)?$/iu;

export type OAuthClient = Readonly<{
  clientId: string;
  clientName: string;
  redirectUris: ReadonlyArray<string>;
}>;

export type AuthorizationRequest = Readonly<{
  responseType: "code";
  clientId: string;
  redirectUri: string;
  scope: string;
  scopes: ReadonlyArray<string>;
  resource: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}>;

export type OAuthProtocolError = Error & Readonly<{
  oauthCode: string;
  status: 400 | 401;
}>;

export const oauthError = (
  oauthCode: string,
  message: string,
  status: 400 | 401,
): OAuthProtocolError => Object.assign(new Error(message), { oauthCode, status });

export const isOAuthProtocolError = (error: unknown): error is OAuthProtocolError =>
  error instanceof Error
  && typeof (error as Partial<OAuthProtocolError>).oauthCode === "string"
  && ((error as Partial<OAuthProtocolError>).status === 400 || (error as Partial<OAuthProtocolError>).status === 401);

const isLoopbackHostname = (hostname: string): boolean =>
  hostname === "localhost"
  || hostname === "[::1]"
  || /^127(?:\.\d{1,3}){3}$/u.test(hostname);

const getProductionIssuerBaseDomain = (value: string, url: URL): string | null => {
  const prefix = "auth.";
  if (
    url.protocol !== "https:"
    || url.origin !== value
    || url.port !== ""
    || !url.hostname.startsWith(prefix)
    || url.hostname.length === prefix.length
  ) {
    return null;
  }
  return url.hostname.slice(prefix.length);
};

const isLoopbackIssuer = (value: string, url: URL): boolean =>
  url.protocol === "http:" && url.origin === value && isLoopbackHostname(url.hostname);

const getProductionResourceBaseDomain = (value: string, url: URL): string | null => {
  const prefix = "mcp.";
  if (
    value !== `${url.origin}/mcp`
    || url.protocol !== "https:"
    || !url.hostname.startsWith(prefix)
    || url.hostname.length === prefix.length
    || url.port !== ""
    || url.pathname !== "/mcp"
    || url.search !== ""
    || url.hash !== ""
    || url.username !== ""
    || url.password !== ""
  ) {
    return null;
  }
  return url.hostname.slice(prefix.length);
};

const isLoopbackResource = (value: string, url: URL): boolean =>
  value === `${url.origin}/mcp`
  && url.protocol === "http:"
  && isLoopbackHostname(url.hostname)
  && url.pathname === "/mcp"
  && url.search === ""
  && url.hash === ""
  && url.username === ""
  && url.password === "";

export const getOAuthConfig = (): Readonly<{ issuer: string; resource: string }> => {
  const issuer = process.env.OAUTH_ISSUER ?? "";
  const resource = process.env.OAUTH_RESOURCE ?? "";
  if (issuer === "" || resource === "") {
    throw new Error("OAuth server is not configured: OAUTH_ISSUER and OAUTH_RESOURCE are required");
  }
  let issuerUrl: URL;
  let resourceUrl: URL;
  try {
    issuerUrl = new URL(issuer);
    resourceUrl = new URL(resource);
  } catch {
    throw new Error("OAuth server is misconfigured: OAUTH_ISSUER and OAUTH_RESOURCE must be absolute URLs");
  }
  const issuerBaseDomain = getProductionIssuerBaseDomain(issuer, issuerUrl);
  const resourceBaseDomain = getProductionResourceBaseDomain(resource, resourceUrl);
  const productionPair = issuerBaseDomain !== null
    && resourceBaseDomain !== null
    && issuerBaseDomain === resourceBaseDomain;
  const loopbackPair = isLoopbackIssuer(issuer, issuerUrl)
    && isLoopbackResource(resource, resourceUrl)
    && issuerUrl.hostname === resourceUrl.hostname;
  if (!productionPair && !loopbackPair) {
    throw new Error("OAuth server is misconfigured: expected HTTPS auth.<domain> and mcp.<same-domain>/mcp URLs or HTTP URLs on the same loopback hostname");
  }
  return { issuer, resource };
};

export const isValidClientRedirectUri = (value: string): boolean => {
  if (
    value.length === 0
    || value.length > 2048
    || value.includes("#")
    || /[\u0000-\u001F\u007F]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || !RAW_REDIRECT_URI_RE.test(value)
    || (/^https:/iu.test(value) && !RAW_HTTPS_REDIRECT_URI_RE.test(value))
    || (/^http:/iu.test(value) && !RAW_HTTP_REDIRECT_URI_RE.test(value))
  ) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
  const scheme = url.protocol.slice(0, -1);
  const reserved = ["about", "blob", "data", "file", "ftp", "javascript", "mailto", "tel", "urn"];
  return /^[a-z][a-z0-9+.-]*$/u.test(scheme)
    && !reserved.includes(scheme)
    && (url.hostname !== "" || url.pathname.startsWith("/"));
};

export const normalizeScopes = (scope: string): ReadonlyArray<string> => {
  const requested = scope.split(" ").filter((value) => value !== "");
  const unique = new Set(requested);
  if (
    requested.length !== unique.size
    || !unique.has("expenses:read")
    || requested.some((value) => !(OAUTH_SCOPES as ReadonlyArray<string>).includes(value))
  ) {
    throw oauthError("invalid_scope", "Scope must include expenses:read and may include expenses:write", 400);
  }
  return OAUTH_SCOPES.filter((value) => unique.has(value));
};

export const narrowScopes = (
  grantedScopes: ReadonlyArray<string>,
  requestedScopes: ReadonlyArray<string> | null,
): ReadonlyArray<string> => {
  const granted = normalizeScopes(grantedScopes.join(" "));
  if (requestedScopes === null) return granted;
  const requested = normalizeScopes(requestedScopes.join(" "));
  if (requested.some((scope) => !granted.includes(scope))) {
    throw oauthError("invalid_scope", "Refresh scope cannot exceed the original grant", 400);
  }
  return requested;
};

const readSingleParameter = (params: URLSearchParams, name: string): string | undefined => {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw oauthError("invalid_request", `OAuth parameter ${name} must appear exactly once`, 400);
  }
  const value = values[0];
  if ((value?.length ?? 0) > 2048) throw oauthError("invalid_request", `OAuth parameter ${name} is too long`, 400);
  return value;
};

const readRequiredParameter = (params: URLSearchParams, name: string): string => {
  const value = readSingleParameter(params, name);
  if (value === undefined || value === "") {
    throw oauthError("invalid_request", `OAuth parameter ${name} must appear exactly once`, 400);
  }
  return value;
};

const readOptionalParameter = (params: URLSearchParams, name: string): string =>
  readSingleParameter(params, name) ?? "";

export const parseAuthorizationRequest = (
  params: URLSearchParams,
  client: OAuthClient,
  expectedResource: string,
): AuthorizationRequest => {
  const responseType = readRequiredParameter(params, "response_type");
  const clientId = readRequiredParameter(params, "client_id");
  const redirectUri = readRequiredParameter(params, "redirect_uri");
  const scope = readRequiredParameter(params, "scope");
  const resource = readRequiredParameter(params, "resource");
  const state = readOptionalParameter(params, "state");
  const codeChallenge = readRequiredParameter(params, "code_challenge");
  const codeChallengeMethod = readRequiredParameter(params, "code_challenge_method");

  if (responseType !== "code") throw oauthError("unsupported_response_type", "Only response_type=code is supported", 400);
  if (clientId !== client.clientId) throw oauthError("invalid_request", "client_id does not match the registered client", 400);
  if (!client.redirectUris.includes(redirectUri)) throw oauthError("invalid_request", "redirect_uri is not registered", 400);
  if (resource !== expectedResource) throw oauthError("invalid_target", "resource does not match this MCP server", 400);
  if (codeChallengeMethod !== "S256" || !CODE_CHALLENGE_RE.test(codeChallenge)) {
    throw oauthError("invalid_request", "S256 PKCE with a valid code_challenge is required", 400);
  }
  const scopes = normalizeScopes(scope);
  return { responseType: "code", clientId, redirectUri, scope: scopes.join(" "), scopes, resource, state, codeChallenge, codeChallengeMethod: "S256" };
};

export const verifyCodeVerifier = (verifier: string, challenge: string): boolean => {
  if (!CODE_VERIFIER_RE.test(verifier) || !CODE_CHALLENGE_RE.test(challenge)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  return timingSafeEqual(Buffer.from(actual), Buffer.from(challenge));
};

export const createOpaqueToken = (prefix: "cl" | "ac" | "at" | "rt"): string =>
  `ebt_${prefix}_${randomBytes(32).toString("base64url")}`;

export const hashOpaqueToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
