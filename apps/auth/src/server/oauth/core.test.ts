import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  getOAuthConfig,
  isValidClientRedirectUri,
  parseAuthorizationRequest,
  verifyCodeVerifier,
  type OAuthClient,
} from "./core.js";

const withOAuthConfig = (
  issuer: string,
  resource: string,
  operation: () => void,
): void => {
  const previousIssuer = process.env.OAUTH_ISSUER;
  const previousResource = process.env.OAUTH_RESOURCE;
  process.env.OAUTH_ISSUER = issuer;
  process.env.OAUTH_RESOURCE = resource;
  try {
    operation();
  } finally {
    if (previousIssuer === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = previousIssuer;
    if (previousResource === undefined) delete process.env.OAUTH_RESOURCE;
    else process.env.OAUTH_RESOURCE = previousResource;
  }
};

const client: OAuthClient = {
  clientId: "ebt_cl_registered-client",
  clientName: "Test client",
  redirectUris: ["https://client.example/callback"],
};

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");

const authorizationParams = (): URLSearchParams => new URLSearchParams({
  response_type: "code",
  client_id: client.clientId,
  redirect_uri: client.redirectUris[0] ?? "",
  scope: "expenses:read expenses:write",
  resource: "https://mcp.example.com/mcp",
  state: "state-1",
  code_challenge: challenge,
  code_challenge_method: "S256",
});

test("OAuth config accepts a production issuer and resource on the same base domain", (): void => {
  withOAuthConfig(
    "https://auth.example.com",
    "https://mcp.example.com/mcp",
    () => assert.deepEqual(getOAuthConfig(), {
      issuer: "https://auth.example.com",
      resource: "https://mcp.example.com/mcp",
    }),
  );
});

test("OAuth config accepts loopback pairs only on the same hostname", (): void => {
  const configurations: ReadonlyArray<Readonly<[string, string]>> = [
    ["http://localhost:8081", "http://localhost:8082/mcp"],
    ["http://127.10.20.30:8081", "http://127.10.20.30:8082/mcp"],
    ["http://[::1]:8081", "http://[::1]:8082/mcp"],
  ];
  for (const [issuer, resource] of configurations) {
    withOAuthConfig(issuer, resource, () => assert.deepEqual(getOAuthConfig(), { issuer, resource }));
  }
});

test("OAuth config rejects different production base domains and loopback hosts", (): void => {
  const configurations: ReadonlyArray<Readonly<[string, string]>> = [
    ["https://auth.example.com", "https://mcp.other.example/mcp"],
    ["http://127.10.20.30:8081", "http://127.0.0.1:8082/mcp"],
    ["http://localhost:8081", "http://127.0.0.1:8082/mcp"],
  ];
  for (const [issuer, resource] of configurations) {
    withOAuthConfig(issuer, resource, () => assert.throws(getOAuthConfig, /misconfigured/u));
  }
});

test("OAuth config rejects malformed or mixed-class pairs", (): void => {
  const configurations: ReadonlyArray<Readonly<[string, string]>> = [
    ["http://auth.example.com", "http://mcp.example.com/mcp"],
    ["https://auth.example.com", "http://localhost:8082/mcp"],
    ["http://localhost:8081", "https://mcp.example.com/mcp"],
    ["https://login.example.com", "https://mcp.example.com/mcp"],
    ["https://auth.example.com:8443", "https://mcp.example.com/mcp"],
    ["http://localhost:8081/path", "http://localhost:8082/mcp"],
    ["http://localhost:8081", "http://localhost:8082/mcp?query=1"],
    ["http://user@localhost:8081", "http://localhost:8082/mcp"],
  ];
  for (const [issuer, resource] of configurations) {
    withOAuthConfig(issuer, resource, () => assert.throws(getOAuthConfig, /misconfigured/u));
  }
});

test("OAuth config rejects bare query and fragment delimiters on resources", (): void => {
  const configurations: ReadonlyArray<Readonly<[string, string]>> = [
    ["https://auth.example.com", "https://mcp.example.com/mcp?"],
    ["https://auth.example.com", "https://mcp.example.com/mcp#"],
    ["http://localhost:8081", "http://localhost:8082/mcp?"],
    ["http://localhost:8081", "http://localhost:8082/mcp#"],
  ];
  for (const [issuer, resource] of configurations) {
    withOAuthConfig(issuer, resource, () => assert.throws(getOAuthConfig, /misconfigured/u));
  }
});

test("DCR redirect validation accepts supported public-client callbacks", (): void => {
  assert.equal(isValidClientRedirectUri("https://client.example/callback"), true);
  assert.equal(isValidClientRedirectUri("HTTPS://CLIENT.EXAMPLE:443/callback"), true);
  assert.equal(isValidClientRedirectUri("http://127.0.0.1:49152/callback"), true);
  assert.equal(isValidClientRedirectUri("http://[::1]:49152/callback"), true);
  assert.equal(isValidClientRedirectUri("http://localhost:49152/callback"), true);
  assert.equal(isValidClientRedirectUri("com.example.client:/callback"), true);
  assert.equal(isValidClientRedirectUri("expense-tracker://callback"), true);
  assert.equal(isValidClientRedirectUri("https://client.example/callback%0Adata"), true);
});

test("DCR redirect validation rejects unsafe callbacks", (): void => {
  assert.equal(isValidClientRedirectUri("http://client.example/callback"), false);
  assert.equal(isValidClientRedirectUri("https://user:password@client.example/callback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/callback#fragment"), false);
  assert.equal(isValidClientRedirectUri("javascript:alert(1)"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call back"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\tback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\nback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\rback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\u0000back"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\u001fback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/call\u007fback"), false);
  assert.equal(isValidClientRedirectUri("https://client.example/callback%ZZ"), false);
  assert.equal(isValidClientRedirectUri("https://client.example\\callback"), false);
  assert.equal(isValidClientRedirectUri("https:client.example/callback"), false);
  assert.equal(isValidClientRedirectUri("https:///client.example/callback"), false);
});

test("authorization request requires exact bindings and mandatory read scope", (): void => {
  const parsed = parseAuthorizationRequest(authorizationParams(), client, "https://mcp.example.com/mcp");
  assert.deepEqual(parsed.scopes, ["expenses:read", "expenses:write"]);

  const wrongRedirect = authorizationParams();
  wrongRedirect.set("redirect_uri", "https://client.example/other");
  assert.throws(() => parseAuthorizationRequest(wrongRedirect, client, "https://mcp.example.com/mcp"), /not registered/u);

  const missingRead = authorizationParams();
  missingRead.set("scope", "expenses:write");
  assert.throws(() => parseAuthorizationRequest(missingRead, client, "https://mcp.example.com/mcp"), /must include expenses:read/u);
});

test("authorization request rejects duplicate hidden values", (): void => {
  const params = authorizationParams();
  params.append("resource", "https://mcp.example.com/mcp");
  assert.throws(() => parseAuthorizationRequest(params, client, "https://mcp.example.com/mcp"), /must appear exactly once/u);
});

test("PKCE verifier accepts only the verifier bound to the S256 challenge", (): void => {
  assert.equal(verifyCodeVerifier(verifier, challenge), true);
  assert.equal(verifyCodeVerifier(`${verifier}x`, challenge), false);
  assert.equal(verifyCodeVerifier("too-short", challenge), false);
});
