import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MAX_OAUTH_AUTHORIZE_QUERY_BYTES,
  MAX_OAUTH_LOGIN_QUERY_BYTES,
} from "@expense-budget-tracker/agent-shared";
import {
  createOAuthApp,
  MAX_CONSENT_REQUEST_BYTES,
  MAX_DCR_REQUEST_BYTES,
  MAX_TOKEN_REQUEST_BYTES,
  type OAuthRouteDependencies,
} from "./oauth.js";
import { clearBrowserSessionCookies } from "../server/oauth/session.js";
import type { OAuthClient } from "../server/oauth/core.js";
import type {
  OAuthAuthorizationServerErrorEvent,
  OAuthEndpointServerErrorEvent,
} from "../server/logger.js";

type OAuthTestLogEvent = OAuthAuthorizationServerErrorEvent | OAuthEndpointServerErrorEvent;

const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/mcp";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const client: OAuthClient = {
  clientId: "ebt_cl_registered-client",
  clientName: "Desktop <MCP>",
  redirectUris: ["https://client.example/callback?next=a&source=b"],
};
const exactRedirectUri = "https://client.example/callback?code=registered-code&error=registered-error&error_description=registered-description&state=registered-state&next=a%2Fb%20c";
const exactRedirectClient: OAuthClient = {
  clientId: "ebt_cl_exact-redirect-client",
  clientName: "Exact redirect client",
  redirectUris: [exactRedirectUri],
};

const createDependencies = (
  overrides: Partial<OAuthRouteDependencies>,
): OAuthRouteDependencies => ({
  getOAuthConfig: () => ({ issuer, resource }),
  getOAuthClient: async (clientId) => clientId === client.clientId ? client : null,
  registerOAuthClient: async (clientName, redirectUris) => ({
    clientId: "ebt_cl_created-client", clientName, redirectUris,
  }),
  issueAuthorizationCode: async () => "ebt_ac_issued-code",
  exchangeAuthorizationCode: async () => ({
    accessToken: "ebt_at_access", refreshToken: "ebt_rt_refresh",
    expiresIn: 3600, scope: "expenses:read",
  }),
  exchangeRefreshToken: async () => ({
    accessToken: "ebt_at_access", refreshToken: "ebt_rt_refresh",
    expiresIn: 3600, scope: "expenses:read",
  }),
  resolveBrowserSession: async () => ({ userId: "user-1", email: "user@example.com" }),
  log: () => {},
  ...overrides,
});

const authorizationParamsForClient = (oauthClient: OAuthClient, state: string): URLSearchParams => new URLSearchParams({
  response_type: "code",
  client_id: oauthClient.clientId,
  redirect_uri: oauthClient.redirectUris[0] ?? "",
  scope: "expenses:read expenses:write",
  resource,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
});

const authorizationParams = (): URLSearchParams => authorizationParamsForClient(client, "state-1");

const consentRequest = (
  params: URLSearchParams,
  origin: string | null,
  secFetchSite: string | null,
): Request => {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: "session=valid-session",
  });
  if (origin !== null) headers.set("Origin", origin);
  if (secFetchSite !== null) headers.set("Sec-Fetch-Site", secFetchSite);
  return new Request(`${issuer}/oauth/authorize`, {
    method: "POST",
    headers,
    body: params.toString(),
  });
};

type BodyLimitCase = Readonly<{
  name: string;
  url: string;
  contentType: string;
  maxBytes: number;
  expectedError: "invalid_client_metadata" | "invalid_request";
  headers: Readonly<Record<string, string>>;
}>;

const bodyLimitCases: ReadonlyArray<BodyLimitCase> = [
  {
    name: "DCR JSON",
    url: `${issuer}/oauth/register`,
    contentType: "application/json",
    maxBytes: MAX_DCR_REQUEST_BYTES,
    expectedError: "invalid_client_metadata",
    headers: {},
  },
  {
    name: "consent form",
    url: `${issuer}/oauth/authorize`,
    contentType: "application/x-www-form-urlencoded",
    maxBytes: MAX_CONSENT_REQUEST_BYTES,
    expectedError: "invalid_request",
    headers: { Origin: issuer, "Sec-Fetch-Site": "same-origin" },
  },
  {
    name: "token form",
    url: `${issuer}/oauth/token`,
    contentType: "application/x-www-form-urlencoded",
    maxBytes: MAX_TOKEN_REQUEST_BYTES,
    expectedError: "invalid_request",
    headers: {},
  },
];

const requestHeaders = (bodyCase: BodyLimitCase): Headers => {
  const headers = new Headers(bodyCase.headers);
  headers.set("Content-Type", bodyCase.contentType);
  return headers;
};

const streamedOverflowRequest = (
  bodyCase: BodyLimitCase,
): Readonly<{ request: Request; wasCancelled: () => boolean }> => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new Uint8Array(bodyCase.maxBytes));
      controller.enqueue(new Uint8Array(1));
    },
    cancel: () => { cancelled = true; },
  });
  const init: RequestInit & Readonly<{ duplex: "half" }> = {
    method: "POST",
    headers: requestHeaders(bodyCase),
    body,
    duplex: "half",
  };
  return {
    request: new Request(bodyCase.url, init),
    wasCancelled: () => cancelled,
  };
};

for (const bodyCase of bodyLimitCases) {
  test(`${bodyCase.name} rejects an oversized Content-Length before parsing`, async (): Promise<void> => {
    const app = createOAuthApp(createDependencies({}));
    const headers = requestHeaders(bodyCase);
    headers.set("Content-Length", String(bodyCase.maxBytes + 1));
    const response = await app.fetch(new Request(bodyCase.url, {
      method: "POST",
      headers,
      body: "x",
    }));

    assert.equal(response.status, 400);
    const payload = await response.json() as Readonly<Record<string, unknown>>;
    assert.equal(payload["error"], bodyCase.expectedError);
    assert.match(String(payload["error_description"]), /must not exceed/u);
  });

  test(`${bodyCase.name} cancels a streamed body as soon as it exceeds the byte limit`, async (): Promise<void> => {
    const app = createOAuthApp(createDependencies({}));
    const streamed = streamedOverflowRequest(bodyCase);
    const response = await app.fetch(streamed.request);

    assert.equal(response.status, 400);
    const payload = await response.json() as Readonly<Record<string, unknown>>;
    assert.equal(payload["error"], bodyCase.expectedError);
    assert.match(String(payload["error_description"]), /must not exceed/u);
    assert.equal(streamed.wasCancelled(), true);
  });
}

test("DCR validates public callbacks before persisting registration", async (): Promise<void> => {
  const registrations: Array<Readonly<{ clientName: string; redirectUris: ReadonlyArray<string> }>> = [];
  const app = createOAuthApp(createDependencies({
    registerOAuthClient: async (clientName, redirectUris) => {
      registrations.push({ clientName, redirectUris });
      return { clientId: "ebt_cl_created-client", clientName, redirectUris };
    },
  }));

  const accepted = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "CLI",
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
    }),
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  const registration = await accepted.json() as Readonly<Record<string, unknown>>;
  assert.equal(registration["token_endpoint_auth_method"], "none");
  assert.equal("client_secret" in registration, false);
  assert.deepEqual(registrations, [{
    clientName: "CLI",
    redirectUris: ["http://127.0.0.1:43123/callback"],
  }]);

  const percentEncoded = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://client.example/callback%0Adata"] }),
  });
  assert.equal(percentEncoded.status, 201);
  assert.deepEqual(registrations[1]?.redirectUris, ["https://client.example/callback%0Adata"]);

  const invalidRawRedirects = [
    "https://client.example/call back",
    "https://client.example/call\tback",
    "https://client.example/call\nback",
    "https://client.example/call\rback",
    "https://client.example/call\u0000back",
    "https://client.example/call\u001fback",
    "https://client.example/call\u007fback",
    "https://client.example/callback%ZZ",
    "https://client.example\\callback",
    "https:client.example/callback",
    "https:///client.example/callback",
  ];
  for (const redirectUri of invalidRawRedirects) {
    const invalidRaw = await app.request(`${issuer}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    assert.equal(invalidRaw.status, 400);
    const error = await invalidRaw.json() as Readonly<Record<string, unknown>>;
    assert.equal(error["error"], "invalid_redirect_uri");
  }

  const rejected = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://attacker.example/callback"] }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(registrations.length, 2);
});

test("DCR persistence failures return generic JSON and log no registration body values", async (): Promise<void> => {
  const clientName = "client-name-must-not-log";
  const redirectUri = "https://client.example/callback%2Fmust-not-log";
  const events: OAuthTestLogEvent[] = [];
  const app = createOAuthApp(createDependencies({
    registerOAuthClient: async () => {
      throw new Error(`Database rejected ${clientName} and ${redirectUri}`);
    },
    log: (event) => { events.push(event); },
  }));

  const response = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(await response.json(), {
    error: "server_error",
    error_description: "Client registration could not be completed",
  });
  assert.deepEqual(events, [{
    domain: "auth",
    action: "oauth_endpoint_server_error",
    endpoint: "registration",
    errorType: "error",
  }]);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(clientName), false);
  assert.equal(serializedEvents.includes(redirectUri), false);
});

const registrationBody = (padding: string): string => JSON.stringify({
  client_name: "CLI",
  redirect_uris: ["http://127.0.0.1:43123/callback"],
  padding,
});

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

const consentParametersWithEncodedSize = (
  oauthClient: OAuthClient,
  targetBytes: number,
): URLSearchParams => {
  const params = authorizationParamsForClient(oauthClient, "");
  params.set("decision", "allow");
  const remainingBytes = targetBytes - utf8Length(params.toString());
  if (remainingBytes < 0) throw new RangeError("Target consent size is smaller than the fixed form fields");
  const encodedCharacters = Math.floor(remainingBytes / 3);
  const asciiCharacters = remainingBytes % 3;
  params.set("state", `${"~".repeat(encodedCharacters)}${"x".repeat(asciiCharacters)}`);
  const state = params.get("state");
  if (state === null || state.length > 2048 || utf8Length(params.toString()) !== targetBytes) {
    throw new RangeError("Target consent size cannot be represented within the state parameter limit");
  }
  params.delete("decision");
  return params;
};

const authorizationParametersWithEncodedSize = (targetBytes: number): URLSearchParams => {
  const params = authorizationParams();
  const prefix = "é/?&=+";
  params.set("state", prefix);
  const remainingBytes = targetBytes - utf8Length(params.toString());
  if (remainingBytes < 0) throw new RangeError("Target authorization query is too small");
  const multibyteCharacters = Math.floor(remainingBytes / 6);
  const asciiCharacters = remainingBytes % 6;
  params.set("state", `${prefix}${"é".repeat(multibyteCharacters)}${"x".repeat(asciiCharacters)}`);
  const state = params.get("state");
  if (state === null || state.length > 2048 || utf8Length(params.toString()) !== targetBytes) {
    throw new RangeError("Target authorization query cannot fit within the state parameter limit");
  }
  return params;
};

test("DCR enforces its request ceiling in UTF-8 bytes before JSON parsing", async (): Promise<void> => {
  let registrationCount = 0;
  const app = createOAuthApp(createDependencies({
    registerOAuthClient: async (clientName, redirectUris) => {
      registrationCount += 1;
      return { clientId: "ebt_cl_created-client", clientName, redirectUris };
    },
  }));
  const emptyBody = registrationBody("");
  const exactBody = registrationBody("x".repeat(MAX_DCR_REQUEST_BYTES - utf8Length(emptyBody)));
  assert.equal(utf8Length(exactBody), MAX_DCR_REQUEST_BYTES);
  const accepted = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: exactBody,
  });
  assert.equal(accepted.status, 201);

  const overBoundaryBody = registrationBody("x".repeat(MAX_DCR_REQUEST_BYTES - utf8Length(emptyBody) + 1));
  assert.equal(utf8Length(overBoundaryBody), MAX_DCR_REQUEST_BYTES + 1);
  const overBoundary = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: overBoundaryBody,
  });
  assert.equal(overBoundary.status, 400);
  const overBoundaryError = await overBoundary.json() as Readonly<Record<string, unknown>>;
  assert.equal(overBoundaryError["error"], "invalid_client_metadata");
  assert.match(String(overBoundaryError["error_description"]), /must not exceed 7500 UTF-8 bytes/u);

  const multibyteBody = registrationBody("é".repeat(Math.ceil((MAX_DCR_REQUEST_BYTES - utf8Length(emptyBody) + 1) / 2)));
  assert.ok(multibyteBody.length < MAX_DCR_REQUEST_BYTES);
  assert.ok(utf8Length(multibyteBody) > MAX_DCR_REQUEST_BYTES);
  const multibyte = await app.request(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: multibyteBody,
  });
  assert.equal(multibyte.status, 400);
  const multibyteError = await multibyte.json() as Readonly<Record<string, unknown>>;
  assert.equal(multibyteError["error"], "invalid_client_metadata");
  assert.equal(registrationCount, 1);
});

test("consent is no-store, anti-clickjacking, and same-origin protected", async (): Promise<void> => {
  let issueCount = 0;
  const app = createOAuthApp(createDependencies({
    issueAuthorizationCode: async () => {
      issueCount += 1;
      return "ebt_ac_issued-code";
    },
  }));
  const query = authorizationParams();
  const consentPage = await app.request(`${issuer}/oauth/authorize?${query.toString()}`, {
    headers: { Cookie: "session=valid-session" },
  });
  assert.equal(consentPage.status, 200);
  assert.equal(consentPage.headers.get("cache-control"), "no-store");
  assert.equal(consentPage.headers.get("x-frame-options"), "DENY");
  assert.equal(consentPage.headers.get("referrer-policy"), "strict-origin");
  assert.equal(
    consentPage.headers.get("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  const consentHtml = await consentPage.text();
  assert.match(consentHtml, /<h1>Connect <bdi dir="auto">Desktop &lt;MCP&gt;<\/bdi> to Expense Budget Tracker\?<\/h1>/u);
  assert.match(consentHtml, /Desktop &lt;MCP&gt;/u);
  assert.equal(consentHtml.includes("Desktop <MCP>"), false);
  assert.match(consentHtml, /connecting app supplied the displayed name/u);
  assert.match(consentHtml, /Expense Budget Tracker has not verified who operates it/u);
  assert.match(consentHtml, /Continue only if you started this connection and recognize the destination below/u);
  assert.match(consentHtml, /After approval, you'll return to/u);
  assert.match(consentHtml, /<p class="callback">https:\/\/client\.example<\/p>/u);
  assert.match(consentHtml, /does not verify who operates the app/u);
  assert.match(consentHtml, /<strong>Read access:<\/strong> View all financial data in the workspaces you can access\./u);
  assert.match(consentHtml, /<strong>Write access:<\/strong> Create, change, and delete financial data\./u);
  assert.match(consentHtml, /<details class="technical"><summary>Technical details<\/summary>/u);
  assert.match(consentHtml, /Client ID<\/dt><dd>ebt_cl_registered-client/u);
  assert.match(consentHtml, /Exact redirect URI<\/dt><dd>https:\/\/client\.example\/callback\?next=a&amp;source=b/u);
  assert.equal(consentHtml.includes("callback?next=a&source=b</dd>"), false);

  const form = authorizationParams();
  form.set("decision", "allow");
  const rejectedSecurityHeaders: ReadonlyArray<readonly [string | null, string | null]> = [
    ["https://attacker.example", "same-origin"],
    ["null", "same-origin"],
    [null, "same-origin"],
    [issuer, "cross-site"],
  ];
  for (const [origin, secFetchSite] of rejectedSecurityHeaders) {
    const rejected = await app.fetch(consentRequest(form, origin, secFetchSite));
    assert.equal(rejected.status, 403);
  }
  assert.equal(issueCount, 0);

  const allowed = await app.fetch(consentRequest(form, issuer, "same-origin"));
  assert.equal(allowed.status, 302);
  assert.match(allowed.headers.get("location") ?? "", /code=ebt_ac_issued-code/u);
  assert.equal(issueCount, 1);

  const allowedWithoutFetchMetadata = await app.fetch(consentRequest(form, issuer, null));
  assert.equal(allowedWithoutFetchMetadata.status, 302);
  assert.equal(issueCount, 2);
});

test("consent isolates a bidi client name from trusted text", async (): Promise<void> => {
  const hostileClient: OAuthClient = {
    clientId: "ebt_cl_hostile-name",
    clientName: "Reports <app>\u202EExpense Budget Tracker",
    redirectUris: ["https://reports.example/callback"],
  };
  const app = createOAuthApp(createDependencies({
    getOAuthClient: async (clientId) => clientId === hostileClient.clientId ? hostileClient : null,
  }));
  const query = authorizationParamsForClient(hostileClient, "state-hostile-name");
  const response = await app.request(`${issuer}/oauth/authorize?${query.toString()}`);

  assert.equal(response.status, 200);
  const html = await response.text();
  const escapedClientName = "Reports &lt;app&gt;\u202EExpense Budget Tracker";
  const isolatedClientName = `<bdi dir="auto">${escapedClientName}</bdi>`;
  assert.equal(html.split(isolatedClientName).length - 1, 2);
  assert.equal(html.includes(`<h1>Connect ${isolatedClientName} to Expense Budget Tracker?</h1>`), true);
  assert.equal(html.includes(`displayed name <strong>${isolatedClientName}</strong>. Expense Budget Tracker has not verified who operates it.`), true);
});

test("consent displays destinations for supported callback shapes", async (): Promise<void> => {
  const callbackCases: ReadonlyArray<Readonly<{ redirectUri: string; destination: string }>> = [
    { redirectUri: "https://business.example/oauth/callback", destination: "https://business.example" },
    { redirectUri: "http://127.0.0.1:49152/callback", destination: "http://127.0.0.1:49152" },
    { redirectUri: "com.example.client:/callback", destination: "com.example.client:" },
    { redirectUri: "expense-tracker://callback/path", destination: "expense-tracker://callback" },
  ];

  for (const [index, callbackCase] of callbackCases.entries()) {
    const callbackClient: OAuthClient = {
      clientId: `ebt_cl_callback-${index}`,
      clientName: "Callback app",
      redirectUris: [callbackCase.redirectUri],
    };
    const app = createOAuthApp(createDependencies({
      getOAuthClient: async (clientId) => clientId === callbackClient.clientId ? callbackClient : null,
    }));
    const query = authorizationParamsForClient(callbackClient, `state-${index}`);
    const response = await app.request(`${issuer}/oauth/authorize?${query.toString()}`);

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal(html.includes(`<p class="callback">${callbackCase.destination}</p>`), true);
    assert.equal(html.includes(`<dt>Exact redirect URI</dt><dd>${callbackCase.redirectUri}</dd>`), true);
  }
});

test("authorization GET enforces its raw query ceiling and keeps nested login below its ceiling", async (): Promise<void> => {
  const exactBoundary = authorizationParametersWithEncodedSize(
    MAX_OAUTH_AUTHORIZE_QUERY_BYTES,
  );
  const authenticatedApp = createOAuthApp(createDependencies({}));
  const accepted = await authenticatedApp.request(
    `${issuer}/oauth/authorize?${exactBoundary.toString()}`,
  );
  assert.equal(accepted.status, 200);

  const oversized = authorizationParametersWithEncodedSize(
    MAX_OAUTH_AUTHORIZE_QUERY_BYTES + 1,
  );
  const rejected = await authenticatedApp.request(
    `${issuer}/oauth/authorize?${oversized.toString()}`,
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    error: "invalid_request",
    error_description: `Authorization query must not exceed ${MAX_OAUTH_AUTHORIZE_QUERY_BYTES} UTF-8 bytes`,
  });

  const anonymousApp = createOAuthApp(createDependencies({
    resolveBrowserSession: async () => null,
  }));
  const redirected = await anonymousApp.request(
    `${issuer}/oauth/authorize?${exactBoundary.toString()}`,
  );
  assert.equal(redirected.status, 302);
  const loginLocation = redirected.headers.get("location") ?? "";
  assert.match(loginLocation, /^https:\/\/auth\.example\.com\/login\?/u);
  assert.ok(utf8Length(new URL(loginLocation).search.slice(1)) <= MAX_OAUTH_LOGIN_QUERY_BYTES);
});

test("consent renders only when both encoded decisions fit the POST byte limit", async (): Promise<void> => {
  let sessionResolutionCount = 0;
  const boundaryClient: OAuthClient = {
    clientId: "ebt_cl_boundary-client",
    clientName: "Boundary client",
    redirectUris: [`https://client.example/${"x".repeat(1_500)}`],
  };
  const app = createOAuthApp(createDependencies({
    getOAuthClient: async (clientId) => clientId === boundaryClient.clientId ? boundaryClient : null,
    resolveBrowserSession: async () => {
      sessionResolutionCount += 1;
      return { userId: "user-1", email: "user@example.com" };
    },
  }));
  const exactBoundary = consentParametersWithEncodedSize(
    boundaryClient,
    MAX_CONSENT_REQUEST_BYTES,
  );
  const exactQuery = exactBoundary.toString().replaceAll("%7E", "~");
  assert.ok(utf8Length(exactQuery) <= MAX_OAUTH_AUTHORIZE_QUERY_BYTES);
  const page = await app.request(`${issuer}/oauth/authorize?${exactQuery}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post" action="\/oauth\/authorize">/u);

  const allowed = new URLSearchParams(exactBoundary);
  allowed.set("decision", "allow");
  assert.equal(utf8Length(allowed.toString()), MAX_CONSENT_REQUEST_BYTES);
  const denied = new URLSearchParams(exactBoundary);
  denied.set("decision", "deny");
  assert.ok(utf8Length(denied.toString()) <= MAX_CONSENT_REQUEST_BYTES);
  const submission = await app.fetch(consentRequest(allowed, issuer, "same-origin"));
  assert.equal(submission.status, 302);

  const oversized = consentParametersWithEncodedSize(
    boundaryClient,
    MAX_CONSENT_REQUEST_BYTES + 1,
  );
  const oversizedQuery = oversized.toString().replaceAll("%7E", "~");
  assert.ok(utf8Length(oversizedQuery) <= MAX_OAUTH_AUTHORIZE_QUERY_BYTES);
  const rejected = await app.request(`${issuer}/oauth/authorize?${oversizedQuery}`);
  assert.equal(rejected.status, 302);
  const location = rejected.headers.get("location") ?? "";
  assert.match(location, /[?&]error=invalid_request(?:&|$)/u);
  assert.match(location, /error_description=Consent%20request%20must%20not%20exceed%207500%20UTF-8%20bytes/u);
  const oversizedState = oversized.get("state");
  assert.notEqual(oversizedState, null);
  assert.ok(location.endsWith(`&state=${encodeURIComponent(oversizedState ?? "")}`));
  assert.equal(sessionResolutionCount, 2);
});

test("authorization success appends parameters without rewriting the registered redirect URI", async (): Promise<void> => {
  const app = createOAuthApp(createDependencies({
    getOAuthClient: async (clientId) => clientId === exactRedirectClient.clientId ? exactRedirectClient : null,
  }));
  const form = authorizationParamsForClient(exactRedirectClient, "state value/%");
  form.set("decision", "allow");

  const response = await app.fetch(consentRequest(form, issuer, "same-origin"));

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `${exactRedirectUri}&code=ebt_ac_issued-code&state=state%20value%2F%25`,
  );
});

test("authorization errors append parameters without rewriting the registered redirect URI", async (): Promise<void> => {
  const app = createOAuthApp(createDependencies({
    getOAuthClient: async (clientId) => clientId === exactRedirectClient.clientId ? exactRedirectClient : null,
  }));
  const params = authorizationParamsForClient(exactRedirectClient, "state value/%");
  params.set("scope", "expenses:write");

  const response = await app.request(`${issuer}/oauth/authorize?${params.toString()}`, {
    headers: { Cookie: "session=valid-session" },
  });

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    `${exactRedirectUri}&error=invalid_scope&error_description=Scope%20must%20include%20expenses%3Aread%20and%20may%20include%20expenses%3Awrite&state=state%20value%2F%25`,
  );
});

test("authorization GET logs and redirects unexpected failures after callback validation", async (): Promise<void> => {
  const accessToken = "ebt_at_must-not-log";
  const events: OAuthTestLogEvent[] = [];
  const app = createOAuthApp(createDependencies({
    resolveBrowserSession: async () => { throw new Error(`JWKS lookup failed near ${accessToken}`); },
    log: (event) => { events.push(event); },
  }));

  const response = await app.request(`${issuer}/oauth/authorize?${authorizationParams().toString()}`);

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://client.example/callback?next=a&source=b&error=server_error&error_description=Authorization%20server%20could%20not%20complete%20the%20request&state=state-1",
  );
  assert.deepEqual(events, [{
    domain: "auth",
    action: "oauth_authorization_server_error",
    method: "GET",
    clientId: client.clientId,
    errorType: "error",
  }]);
  assert.equal(JSON.stringify(events).includes(accessToken), false);
});

test("authorization POST logs and redirects code-persistence failures after callback validation", async (): Promise<void> => {
  const authorizationCode = "ebt_ac_must-not-log";
  const events: OAuthTestLogEvent[] = [];
  const app = createOAuthApp(createDependencies({
    issueAuthorizationCode: async () => { throw new Error(`Authorization code insert failed near ${authorizationCode}`); },
    log: (event) => { events.push(event); },
  }));
  const form = authorizationParams();
  form.set("decision", "allow");

  const response = await app.fetch(consentRequest(form, issuer, "same-origin"));

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://client.example/callback?next=a&source=b&error=server_error&error_description=Authorization%20server%20could%20not%20complete%20the%20request&state=state-1",
  );
  assert.deepEqual(events, [{
    domain: "auth",
    action: "oauth_authorization_server_error",
    method: "POST",
    clientId: client.clientId,
    errorType: "error",
  }]);
  assert.equal(JSON.stringify(events).includes(authorizationCode), false);
});

test("token failures return generic OAuth JSON without logging credentials or validation errors", async (): Promise<void> => {
  const authorizationCode = "ebt_ac_token-must-not-log";
  const events: OAuthTestLogEvent[] = [];
  const app = createOAuthApp(createDependencies({
    exchangeAuthorizationCode: async () => {
      throw new RangeError(`Exchange failed for ${authorizationCode} and ${verifier}`);
    },
    log: (event) => { events.push(event); },
  }));
  const validRequest = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0] ?? "",
    resource,
    code: authorizationCode,
    code_verifier: verifier,
  });

  const response = await app.request(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: validRequest.toString(),
  });

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.deepEqual(await response.json(), {
    error: "server_error",
    error_description: "Token request could not be completed",
  });
  assert.deepEqual(events, [{
    domain: "auth",
    action: "oauth_endpoint_server_error",
    endpoint: "token",
    errorType: "range_error",
  }]);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(authorizationCode), false);
  assert.equal(serializedEvents.includes(verifier), false);

  const invalidResponse = await app.request(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(events.length, 1);
});

test("consent revalidates every submitted authorization field", async (): Promise<void> => {
  let issueCount = 0;
  const app = createOAuthApp(createDependencies({
    issueAuthorizationCode: async () => {
      issueCount += 1;
      return "ebt_ac_must-not-issue";
    },
  }));
  const mutations: ReadonlyArray<Readonly<[string, string]>> = [
    ["response_type", "token"],
    ["client_id", "unknown-client"],
    ["redirect_uri", "https://client.example/other"],
    ["scope", "expenses:write"],
    ["resource", "https://mcp.other.example/mcp"],
    ["state", "x".repeat(2049)],
    ["code_challenge", "invalid"],
    ["code_challenge_method", "plain"],
    ["decision", "unexpected"],
  ];

  for (const [name, value] of mutations) {
    const form = authorizationParams();
    form.set("decision", "allow");
    form.set(name, value);
    const response = await app.fetch(consentRequest(form, issuer, "same-origin"));
    const location = response.headers.get("location") ?? "";
    assert.equal(location.includes("code="), false, `${name} mutation must not issue a code`);
  }
  assert.equal(issueCount, 0);
});

test("invalid non-empty session cookies are cleared before authorize redirects to login", async (): Promise<void> => {
  const app = createOAuthApp(createDependencies({
    resolveBrowserSession: async (c) => {
      clearBrowserSessionCookies(c);
      return null;
    },
  }));
  const response = await app.request(`${issuer}/oauth/authorize?${authorizationParams().toString()}`, {
    headers: { Cookie: "session=expired-session" },
  });

  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/auth\.example\.com\/login\?/u);
  assert.match(response.headers.getSetCookie().join("\n"), /session=;/u);
});
