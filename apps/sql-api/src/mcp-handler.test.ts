import assert from "node:assert/strict";
import test from "node:test";
import type { UserIdentity } from "./db.js";
import { createQueryResult } from "./handlerTestUtils.js";
import {
  authenticateMcpAccessTokenWithDependencies,
  McpAuthenticationError,
  type AuthenticatedMcpAccessToken,
} from "./mcp/auth.js";
import type { McpRuntimeConfig } from "./mcp/config.js";
import { createMcpServer } from "./mcp/server.js";
import type { SqlApiLogEvent } from "./logger.js";
import {
  createMcpApp,
  type McpHandlerDependencies,
} from "./mcp-handler.js";

const ACCESS_TOKEN = `ebt_at_${"A".repeat(43)}`;
const RESOURCE = "https://mcp.example.com/mcp";
const METADATA_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const CONFIG: McpRuntimeConfig = {
  issuer: "https://auth.example.com",
  resource: RESOURCE,
  resourceOrigin: "https://mcp.example.com",
  canonicalHost: "mcp.example.com",
  protectedResourceMetadataUrl: METADATA_URL,
};
const CONNECTION: AuthenticatedMcpAccessToken = {
  connectionId: "connection-1",
  clientId: "client-1",
  resource: RESOURCE,
  scopes: ["expenses:read", "expenses:write"],
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
};

type Authenticator = McpHandlerDependencies["authenticateMcpAccessToken"];

const createDependencies = (
  authenticator: Authenticator,
  logEvents: Array<SqlApiLogEvent>,
): McpHandlerDependencies => ({
  authenticateMcpAccessToken: authenticator,
  createMcpServer,
  getMcpRuntimeConfig: () => CONFIG,
  log: (event) => {
    logEvents.push(event);
  },
});

const authenticatedHeaders = (): Readonly<Record<string, string>> => ({
  authorization: `Bearer ${ACCESS_TOKEN}`,
  host: CONFIG.canonicalHost,
});

const initializeRequest = (): Request => new Request(RESOURCE, {
  method: "POST",
  headers: {
    ...authenticatedHeaders(),
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    origin: CONFIG.resourceOrigin,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-handler-test", version: "1.0.0" },
    },
  }),
});

test("MCP handler serves health and both protected-resource metadata locations", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(async () => CONNECTION, logEvents));

  const health = await app.request("https://mcp.example.com/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    const response = await app.request(`https://mcp.example.com${path}`);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await response.json(), {
      resource: RESOURCE,
      authorization_servers: [CONFIG.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["expenses:read", "expenses:write"],
    });
  }
  assert.deepEqual(logEvents, []);
});

test("MCP handler does not serve any /v1 route aliases", async (): Promise<void> => {
  let authenticationCalls = 0;
  const app = createMcpApp(createDependencies(async () => {
    authenticationCalls += 1;
    return CONNECTION;
  }, []));

  for (const path of [
    "/v1/health",
    "/v1/.well-known/oauth-protected-resource/mcp",
    "/v1/.well-known/oauth-protected-resource",
  ]) {
    const response = await app.request(`https://mcp.example.com${path}`);
    assert.equal(response.status, 404, path);
  }

  const mcp = await app.request("https://mcp.example.com/v1/mcp", {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(mcp.status, 404);
  assert.equal(authenticationCalls, 0);
});

test("MCP handler returns a path-aware Bearer challenge for missing and invalid tokens", async (): Promise<void> => {
  let authenticationCalls = 0;
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(async () => {
    authenticationCalls += 1;
    throw new McpAuthenticationError();
  }, logEvents));

  const missing = await app.request(RESOURCE, {
    method: "POST",
    headers: { host: CONFIG.canonicalHost },
  });
  assert.equal(missing.status, 401);
  assert.equal(
    missing.headers.get("www-authenticate"),
    `Bearer resource_metadata="${METADATA_URL}"`,
  );

  const apiKey = await app.request(RESOURCE, {
    method: "POST",
    headers: {
      authorization: "ApiKey EBTA_12345678_0123456789ABCDEFGHJKMNPQRSTV",
      host: CONFIG.canonicalHost,
    },
  });
  assert.equal(apiKey.status, 401);

  const invalid = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA_URL}"`);
  assert.equal(authenticationCalls, 1);
  assert.deepEqual(logEvents, []);
});

test("MCP handler maps current identity trust failures to the generic Bearer challenge", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const disabledIdentity: UserIdentity = {
    ...CONNECTION.identity,
    cognitoEnabled: false,
  };
  const app = createMcpApp(createDependencies(
    (token, resource) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      {
        query: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: CONNECTION.clientId,
          resource: RESOURCE,
          scopes: CONNECTION.scopes,
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentity: async () => disabledIdentity,
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    ),
    logEvents,
  ));

  const response = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA_URL}"`);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    error: "invalid_token",
    error_description: "A valid OAuth Bearer access token is required for this MCP resource.",
  });
  assert.equal(responseText.includes("disabled"), false);
  assert.deepEqual(logEvents, []);
});

test("MCP handler maps invalid scope snapshots to the generic Bearer challenge", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(
    (token, resource) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      {
        query: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: CONNECTION.clientId,
          resource: RESOURCE,
          scopes: ["expenses:write", "expenses:read"],
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentity: async () => CONNECTION.identity,
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    ),
    logEvents,
  ));

  const response = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `Bearer resource_metadata="${METADATA_URL}"`);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    error: "invalid_token",
    error_description: "A valid OAuth Bearer access token is required for this MCP resource.",
  });
  assert.equal(responseText.includes(ACCESS_TOKEN), false);
  assert.equal(responseText.includes("expenses:write"), false);
  assert.deepEqual(logEvents, []);
});

test("MCP handler keeps unrelated access-token row corruption as an internal error", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(
    (token, resource) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      {
        query: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: 42,
          resource: RESOURCE,
          scopes: CONNECTION.scopes,
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentity: async () => CONNECTION.identity,
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    ),
    logEvents,
  ));

  const response = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("www-authenticate"), null);
  assert.deepEqual(await response.json(), {
    error: "internal_error",
    error_description: "The MCP request could not be authenticated.",
  });
  assert.deepEqual(logEvents, [{
    domain: "sql_api",
    action: "mcp_unexpected_error",
    boundary: "authentication",
    operation: "validate_oauth_access_token",
    errorType: "error",
  }]);
});

test("MCP handler rejects non-canonical Host and Origin before authentication", async (): Promise<void> => {
  let authenticationCalls = 0;
  const app = createMcpApp(createDependencies(async () => {
    authenticationCalls += 1;
    return CONNECTION;
  }, []));

  const wrongHost = await app.request("https://other.example/mcp", {
    method: "POST",
    headers: { ...authenticatedHeaders(), host: "other.example" },
  });
  assert.equal(wrongHost.status, 403);

  const wrongOrigin = await app.request(RESOURCE, {
    method: "POST",
    headers: { ...authenticatedHeaders(), origin: "https://other.example" },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(authenticationCalls, 0);
});

test("MCP handler returns 405 for authenticated GET and DELETE requests", async (): Promise<void> => {
  const app = createMcpApp(createDependencies(async () => CONNECTION, []));

  for (const method of ["GET", "DELETE"]) {
    const response = await app.request(RESOURCE, {
      method,
      headers: authenticatedHeaders(),
    });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST", method);
  }
});

test("MCP handler uses stateless JSON transport with no session identifier", async (): Promise<void> => {
  let serverCreations = 0;
  const dependencies = createDependencies(async (token, resource) => {
    assert.equal(token, ACCESS_TOKEN);
    assert.equal(resource, RESOURCE);
    return CONNECTION;
  }, []);
  const app = createMcpApp({
    ...dependencies,
    createMcpServer: (connection) => {
      serverCreations += 1;
      return createMcpServer(connection);
    },
  });

  for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
    const response = await app.request(initializeRequest());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
    assert.equal(response.headers.get("mcp-session-id"), null);
    const body = await response.json() as Readonly<Record<string, unknown>>;
    assert.equal(body["jsonrpc"], "2.0");
    assert.equal(body["id"], 1);
  }
  assert.equal(serverCreations, 2);
});

test("MCP handler sanitizes and structurally logs unexpected authentication failures", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(async () => {
    throw new Error("password authentication failed for database db.internal.example");
  }, logEvents));

  const response = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(response.status, 500);
  const bodyText = await response.text();
  assert.equal(bodyText.includes("db.internal.example"), false);
  assert.deepEqual(logEvents, [{
    domain: "sql_api",
    action: "mcp_unexpected_error",
    boundary: "authentication",
    operation: "validate_oauth_access_token",
    errorType: "error",
  }]);
});
