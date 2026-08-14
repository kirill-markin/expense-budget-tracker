import { Hono, type Context } from "hono";
import {
  getOAuthConfig,
  isOAuthProtocolError,
  isValidClientRedirectUri,
  normalizeScopes,
  oauthError,
  parseAuthorizationRequest,
  type AuthorizationRequest,
  type OAuthClient,
  type OAuthProtocolError,
} from "../server/oauth/core.js";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getOAuthClient,
  issueAuthorizationCode,
  registerOAuthClient,
} from "../server/oauth/store.js";
import { resolveBrowserSession, type BrowserIdentity } from "../server/oauth/session.js";
import {
  getSafeErrorType,
  log,
  type OAuthAuthorizationServerErrorEvent,
  type OAuthEndpointServerErrorEvent,
} from "../server/logger.js";

type OAuthServerErrorEvent = OAuthAuthorizationServerErrorEvent | OAuthEndpointServerErrorEvent;

export type OAuthRouteDependencies = Readonly<{
  getOAuthConfig: typeof getOAuthConfig;
  getOAuthClient: typeof getOAuthClient;
  registerOAuthClient: typeof registerOAuthClient;
  issueAuthorizationCode: typeof issueAuthorizationCode;
  exchangeAuthorizationCode: typeof exchangeAuthorizationCode;
  exchangeRefreshToken: typeof exchangeRefreshToken;
  resolveBrowserSession: typeof resolveBrowserSession;
  log: (event: OAuthServerErrorEvent) => void;
}>;

const defaultDependencies: OAuthRouteDependencies = {
  getOAuthConfig,
  getOAuthClient,
  registerOAuthClient,
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  resolveBrowserSession,
  log,
};

const noStore = (c: Context): void => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
};

// Leave headroom below the managed WAF's 8 KiB inspected-body threshold.
const MAX_OAUTH_REQUEST_BYTES = 7_500;
export const MAX_DCR_REQUEST_BYTES = MAX_OAUTH_REQUEST_BYTES;
export const MAX_CONSENT_REQUEST_BYTES = MAX_OAUTH_REQUEST_BYTES;
export const MAX_TOKEN_REQUEST_BYTES = MAX_OAUTH_REQUEST_BYTES;

type RequestBodyTooLargeError = Error & Readonly<{
  requestBodyTooLarge: true;
  maxBytes: number;
}>;

const requestBodyTooLargeError = (
  maxBytes: number,
  cause: unknown,
): RequestBodyTooLargeError => Object.assign(
  cause === undefined
    ? new Error(`Request body exceeds ${maxBytes} bytes`)
    : new Error(`Request body exceeds ${maxBytes} bytes`, { cause }),
  { requestBodyTooLarge: true as const, maxBytes },
);

const isRequestBodyTooLargeError = (error: unknown): error is RequestBodyTooLargeError =>
  error instanceof Error
  && (error as Partial<RequestBodyTooLargeError>).requestBodyTooLarge === true;

const hasOversizedContentLength = (request: Request, maxBytes: number): boolean => {
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength === null) return false;
  const contentLength = rawContentLength.trim();
  return /^\d+$/u.test(contentLength) && BigInt(contentLength) > BigInt(maxBytes);
};

const readBoundedRequestBody = async (request: Request, maxBytes: number): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Request body byte limit must be a non-negative safe integer");
  }
  if (hasOversizedContentLength(request, maxBytes)) {
    throw requestBodyTooLargeError(maxBytes, undefined);
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        try {
          await reader.cancel();
        } catch (cause) {
          throw requestBodyTooLargeError(maxBytes, cause);
        }
        throw requestBodyTooLargeError(maxBytes, undefined);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
};

const escapeHtml = (value: string): string => value
  .replace(/&/gu, "&amp;")
  .replace(/</gu, "&lt;")
  .replace(/>/gu, "&gt;")
  .replace(/"/gu, "&quot;")
  .replace(/'/gu, "&#39;");

const CONSENT_DECISIONS = ["deny", "allow"] as const;
type ConsentDecision = typeof CONSENT_DECISIONS[number];
type ConsentFormField = Readonly<[string, string]>;

const consentHiddenFields = (request: AuthorizationRequest): ReadonlyArray<ConsentFormField> => [
  ["response_type", request.responseType], ["client_id", request.clientId],
  ["redirect_uri", request.redirectUri], ["scope", request.scope],
  ["resource", request.resource], ["state", request.state],
  ["code_challenge", request.codeChallenge], ["code_challenge_method", request.codeChallengeMethod],
];

const encodeConsentSubmission = (
  request: AuthorizationRequest,
  decision: ConsentDecision,
): string => {
  const params = new URLSearchParams();
  for (const [name, value] of consentHiddenFields(request)) params.append(name, value);
  params.append("decision", decision);
  return params.toString();
};

const validateConsentSubmissionSize = (request: AuthorizationRequest): void => {
  const encoder = new TextEncoder();
  for (const decision of CONSENT_DECISIONS) {
    if (encoder.encode(encodeConsentSubmission(request, decision)).byteLength > MAX_CONSENT_REQUEST_BYTES) {
      throw oauthError("invalid_request", `Consent request must not exceed ${MAX_CONSENT_REQUEST_BYTES} UTF-8 bytes`, 400);
    }
  }
};

const renderConsent = (client: OAuthClient, request: AuthorizationRequest): string => {
  const hidden = consentHiddenFields(request)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  const permissions = request.scopes.map((scope) => `<li>${scope === "expenses:read" ? "Read expenses and budgets" : "Create and update expenses and budgets"}</li>`).join("");
  const callbackUrl = new URL(request.redirectUri);
  const callbackOrigin = callbackUrl.origin === "null" ? callbackUrl.protocol : callbackUrl.origin;
  const actions = CONSENT_DECISIONS
    .map((decision) => `<button name="decision" value="${decision}" type="submit">${decision === "allow" ? "Allow" : "Deny"}</button>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Authorize MCP client</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111;background:#fff}.card{width:100%;max-width:560px;border:1px solid #232323;padding:28px}h1{font-size:20px;margin:0 0 20px}p,li,dt,dd{font-size:14px;line-height:1.5}.client{font-weight:700;overflow-wrap:anywhere}.warning{padding:10px;border:1px solid #8a5a00;background:#fff8e6}.details{display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}.details dt{font-weight:700}.details dd{margin:0;overflow-wrap:anywhere}.resource{color:#666;overflow-wrap:anywhere}.actions{display:flex;gap:10px;margin-top:24px}button{flex:1;padding:10px;border:1px solid #232323;background:#fff;color:#111;font:inherit;cursor:pointer}button[value=allow]{background:#232323;color:#fff}@media(max-width:540px){body{padding:0}.card{border:0;min-height:100vh;padding:24px 16px}.details{grid-template-columns:1fr}}
</style></head><body><main class="card"><h1>Authorize MCP client</h1><p><span class="client">${escapeHtml(client.clientName)}</span> is requesting access to your Expense Budget Tracker data.</p><p class="warning"><strong>Unverified client name:</strong> this name was provided by the client and is not endorsed by Expense Budget Tracker.</p><dl class="details"><dt>Client ID</dt><dd>${escapeHtml(client.clientId)}</dd><dt>Callback origin</dt><dd>${escapeHtml(callbackOrigin)}</dd><dt>Exact redirect URI</dt><dd>${escapeHtml(request.redirectUri)}</dd></dl><ul>${permissions}</ul><p class="resource">Resource: ${escapeHtml(request.resource)}</p><form method="post" action="/oauth/authorize">${hidden}<div class="actions">${actions}</div></form></main></body></html>`;
};

const readSingleParameter = (params: URLSearchParams, name: string): string | undefined => {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw oauthError("invalid_request", `OAuth parameter ${name} must appear exactly once`, 400);
  }
  const value = values[0];
  if ((value?.length ?? 0) > 4096) throw oauthError("invalid_request", `OAuth parameter ${name} is too long`, 400);
  return value;
};

const readRequiredParameter = (params: URLSearchParams, name: string): string => {
  const value = readSingleParameter(params, name);
  if (value === undefined || value === "") {
    throw oauthError("invalid_request", `OAuth parameter ${name} must appear exactly once`, 400);
  }
  return value;
};

const loadAuthorizationRequest = async (
  params: URLSearchParams,
  resource: string,
  getClient: typeof getOAuthClient,
): Promise<Readonly<{ client: OAuthClient; request: AuthorizationRequest }>> => {
  const clientId = readRequiredParameter(params, "client_id");
  const client = await getClient(clientId);
  if (client === null) throw oauthError("invalid_request", "Unknown OAuth client", 400);
  return { client, request: parseAuthorizationRequest(params, client, resource) };
};

const appendAuthorizationResult = (
  redirectUri: string,
  values: Readonly<Record<string, string>>,
): string => {
  const pairs = Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  if (pairs.length === 0) return redirectUri;
  const separator = redirectUri.includes("?")
    ? redirectUri.endsWith("?") || redirectUri.endsWith("&") ? "" : "&"
    : "?";
  return `${redirectUri}${separator}${pairs.join("&")}`;
};

const validatedAuthorizationErrorResponse = (
  c: Context,
  request: AuthorizationRequest,
  oauthCode: string,
  description: string,
): Response => {
  noStore(c);
  return c.redirect(appendAuthorizationResult(request.redirectUri, {
    error: oauthCode,
    error_description: description,
    state: request.state,
  }), 302);
};

const authorizationErrorResponse = async (
  c: Context,
  params: URLSearchParams,
  error: OAuthProtocolError,
  getClient: typeof getOAuthClient,
): Promise<Response> => {
  noStore(c);
  const clientId = params.getAll("client_id");
  const redirectUri = params.getAll("redirect_uri");
  if (clientId.length === 1 && redirectUri.length === 1) {
    const client = await getClient(clientId[0] ?? "");
    if (client?.redirectUris.includes(redirectUri[0] ?? "")) {
      const stateValues = params.getAll("state");
      const state = stateValues.length === 1 && (stateValues[0]?.length ?? 0) <= 2048
        ? stateValues[0] ?? ""
        : "";
      return c.redirect(appendAuthorizationResult(redirectUri[0] ?? "", {
        error: error.oauthCode,
        error_description: error.message,
        state,
      }), 302);
    }
  }
  return c.json({ error: error.oauthCode, error_description: error.message }, error.status);
};

const authorizationServerErrorResponse = (
  c: Context,
  request: AuthorizationRequest,
  method: "GET" | "POST",
  error: unknown,
  writeLog: (event: OAuthAuthorizationServerErrorEvent) => void,
): Response => {
  writeLog({
    domain: "auth",
    action: "oauth_authorization_server_error",
    method,
    clientId: request.clientId,
    errorType: getSafeErrorType(error),
  });
  return validatedAuthorizationErrorResponse(
    c,
    request,
    "server_error",
    "Authorization server could not complete the request",
  );
};

const oauthEndpointServerErrorResponse = (
  c: Context,
  endpoint: "registration" | "token",
  description: string,
  error: unknown,
  writeLog: (event: OAuthEndpointServerErrorEvent) => void,
): Response => {
  writeLog({
    domain: "auth",
    action: "oauth_endpoint_server_error",
    endpoint,
    errorType: getSafeErrorType(error),
  });
  noStore(c);
  return c.json({ error: "server_error", error_description: description }, 500);
};

const buildLoginRedirect = (issuer: string, request: AuthorizationRequest): string => {
  const authorizationUrl = new URL("/oauth/authorize", issuer);
  for (const [name, value] of Object.entries({
    response_type: request.responseType, client_id: request.clientId,
    redirect_uri: request.redirectUri, scope: request.scope, resource: request.resource,
    state: request.state, code_challenge: request.codeChallenge,
    code_challenge_method: request.codeChallengeMethod,
  })) authorizationUrl.searchParams.set(name, value);
  const loginUrl = new URL("/login", issuer);
  loginUrl.searchParams.set("redirect_uri", authorizationUrl.toString());
  return loginUrl.toString();
};

const requireBrowserIdentity = async (
  c: Context,
  loginRedirect: string,
  dependencies: OAuthRouteDependencies,
): Promise<BrowserIdentity | Response> => {
  const identity = await dependencies.resolveBrowserSession(c);
  return identity === null ? c.redirect(loginRedirect, 302) : identity;
};

export const createOAuthApp = (dependencies: OAuthRouteDependencies): Hono => {
const app = new Hono();

app.get("/.well-known/oauth-authorization-server", (c) => {
  const { issuer } = dependencies.getOAuthConfig();
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["expenses:read", "expenses:write"],
  });
});

app.post("/oauth/register", async (c) => {
  noStore(c);
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return c.json({ error: "invalid_client_metadata", error_description: "Registration request must be JSON" }, 400);
  }
  let rawBody: string;
  try {
    rawBody = await readBoundedRequestBody(c.req.raw, MAX_DCR_REQUEST_BYTES);
  } catch (error) {
    if (isRequestBodyTooLargeError(error)) {
      return c.json({ error: "invalid_client_metadata", error_description: `Registration request must not exceed ${MAX_DCR_REQUEST_BYTES} UTF-8 bytes` }, 400);
    }
    return c.json({ error: "invalid_client_metadata", error_description: "Registration request body could not be read" }, 400);
  }
  let body: unknown;
  try { body = JSON.parse(rawBody) as unknown; } catch { return c.json({ error: "invalid_client_metadata", error_description: "Request body must be JSON" }, 400); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "invalid_client_metadata", error_description: "Request body must be a JSON object" }, 400);
  const metadata = body as Readonly<Record<string, unknown>>;
  const redirectUris = metadata["redirect_uris"];
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10 || redirectUris.some((uri) => typeof uri !== "string" || !isValidClientRedirectUri(uri)) || new Set(redirectUris).size !== redirectUris.length) {
    return c.json({ error: "invalid_redirect_uri", error_description: "Provide 1-10 unique HTTPS, loopback HTTP, or private-use redirect URIs without fragments" }, 400);
  }
  const clientNameValue = metadata["client_name"];
  const clientName = clientNameValue === undefined ? "MCP client" : clientNameValue;
  const authMethod = metadata["token_endpoint_auth_method"];
  const grants = metadata["grant_types"];
  const responses = metadata["response_types"];
  const applicationType = metadata["application_type"];
  if (
    typeof clientName !== "string" || clientName.trim() === "" || clientName.length > 200
    || (authMethod !== undefined && authMethod !== "none")
    || metadata["client_secret"] !== undefined
    || (grants !== undefined && (!Array.isArray(grants) || !grants.includes("authorization_code") || new Set(grants).size !== grants.length || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")))
    || (responses !== undefined && (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code"))
    || (applicationType !== undefined && applicationType !== "native" && applicationType !== "web")
  ) return c.json({ error: "invalid_client_metadata", error_description: "Only public authorization-code clients with optional refresh tokens are supported" }, 400);
  const registeredApplicationType = applicationType === "native" || applicationType === "web"
    ? applicationType
    : undefined;
  let client: OAuthClient;
  try {
    client = await dependencies.registerOAuthClient(clientName.trim(), redirectUris as ReadonlyArray<string>);
  } catch (error) {
    return oauthEndpointServerErrorResponse(
      c,
      "registration",
      "Client registration could not be completed",
      error,
      dependencies.log,
    );
  }
  return c.json({ client_id: client.clientId, client_name: client.clientName, redirect_uris: client.redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...(registeredApplicationType === undefined ? {} : { application_type: registeredApplicationType }) }, 201);
});

app.get("/oauth/authorize", async (c) => {
  noStore(c);
  const config = dependencies.getOAuthConfig();
  const params = new URL(c.req.url).searchParams;
  let authorizationRequest: AuthorizationRequest | null = null;
  try {
    const { client, request } = await loadAuthorizationRequest(params, config.resource, dependencies.getOAuthClient);
    authorizationRequest = request;
    validateConsentSubmissionSize(request);
    const identity = await requireBrowserIdentity(c, buildLoginRedirect(config.issuer, request), dependencies);
    if (identity instanceof Response) return identity;
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    return c.html(renderConsent(client, request));
  } catch (error) {
    if (isOAuthProtocolError(error)) {
      return authorizationRequest === null
        ? authorizationErrorResponse(c, params, error, dependencies.getOAuthClient)
        : validatedAuthorizationErrorResponse(c, authorizationRequest, error.oauthCode, error.message);
    }
    if (authorizationRequest === null) throw error;
    return authorizationServerErrorResponse(c, authorizationRequest, "GET", error, dependencies.log);
  }
});

app.post("/oauth/authorize", async (c) => {
  noStore(c);
  const config = dependencies.getOAuthConfig();
  if (c.req.header("origin") !== config.issuer || ![undefined, "same-origin"].includes(c.req.header("sec-fetch-site"))) return c.text("Cross-origin consent submission rejected", 403);
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return c.text("Consent form must be URL encoded", 415);
  let params = new URLSearchParams();
  let authorizationRequest: AuthorizationRequest | null = null;
  try {
    let rawBody: string;
    try {
      rawBody = await readBoundedRequestBody(c.req.raw, MAX_CONSENT_REQUEST_BYTES);
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        throw oauthError("invalid_request", `Consent request must not exceed ${MAX_CONSENT_REQUEST_BYTES} UTF-8 bytes`, 400);
      }
      throw error;
    }
    params = new URLSearchParams(rawBody);
    const { request } = await loadAuthorizationRequest(params, config.resource, dependencies.getOAuthClient);
    authorizationRequest = request;
    const decision = readRequiredParameter(params, "decision");
    const identity = await requireBrowserIdentity(c, buildLoginRedirect(config.issuer, request), dependencies);
    if (identity instanceof Response) return identity;
    if (decision === "deny") return c.redirect(appendAuthorizationResult(request.redirectUri, { error: "access_denied", state: request.state }), 302);
    if (decision !== "allow") throw oauthError("invalid_request", "Consent decision must be allow or deny", 400);
    const code = await dependencies.issueAuthorizationCode(request, identity.userId, identity.email);
    return c.redirect(appendAuthorizationResult(request.redirectUri, { code, state: request.state }), 302);
  } catch (error) {
    if (isOAuthProtocolError(error)) {
      return authorizationRequest === null
        ? authorizationErrorResponse(c, params, error, dependencies.getOAuthClient)
        : validatedAuthorizationErrorResponse(c, authorizationRequest, error.oauthCode, error.message);
    }
    if (authorizationRequest === null) throw error;
    return authorizationServerErrorResponse(c, authorizationRequest, "POST", error, dependencies.log);
  }
});

app.post("/oauth/token", async (c) => {
  noStore(c);
  try {
    if (c.req.header("authorization") !== undefined) throw oauthError("invalid_client", "Client authentication is not supported", 401);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) throw oauthError("invalid_request", "Token request must be URL encoded", 400);
    let rawBody: string;
    try {
      rawBody = await readBoundedRequestBody(c.req.raw, MAX_TOKEN_REQUEST_BYTES);
    } catch (error) {
      if (isRequestBodyTooLargeError(error)) {
        throw oauthError("invalid_request", `Token request must not exceed ${MAX_TOKEN_REQUEST_BYTES} UTF-8 bytes`, 400);
      }
      throw error;
    }
    const params = new URLSearchParams(rawBody);
    const grantType = readRequiredParameter(params, "grant_type");
    const clientId = readRequiredParameter(params, "client_id");
    const resource = readRequiredParameter(params, "resource");
    if (resource !== dependencies.getOAuthConfig().resource) throw oauthError("invalid_target", "resource does not match this MCP server", 400);
    const result = grantType === "authorization_code"
      ? await dependencies.exchangeAuthorizationCode(readRequiredParameter(params, "code"), clientId, readRequiredParameter(params, "redirect_uri"), resource, readRequiredParameter(params, "code_verifier"))
      : grantType === "refresh_token"
        ? await dependencies.exchangeRefreshToken(readRequiredParameter(params, "refresh_token"), clientId, resource, params.has("scope") ? normalizeScopes(readRequiredParameter(params, "scope")) : null)
        : (() => { throw oauthError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported", 400); })();
    return c.json({ access_token: result.accessToken, token_type: "Bearer", expires_in: result.expiresIn, refresh_token: result.refreshToken, scope: result.scope });
  } catch (error) {
    if (isOAuthProtocolError(error)) {
      if (error.status === 401) c.header("WWW-Authenticate", "Basic realm=\"oauth-token\"");
      return c.json({ error: error.oauthCode, error_description: error.message }, error.status);
    }
    return oauthEndpointServerErrorResponse(
      c,
      "token",
      "Token request could not be completed",
      error,
      dependencies.log,
    );
  }
});

return app;
};

export default createOAuthApp(defaultDependencies);
