import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { SqlTransactionOutcomeUnknownError } from "./dbDeadline.js";
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
  createMcpHandler,
  createMcpRequestFromHttpApiV2Event,
  createHttpApiV2ResultFromMcpResponse,
  McpHttpApiV2EventError,
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
  now: Date.now,
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

const createHttpApiV2Event = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  headers: Readonly<Record<string, string>>,
  rawQueryString: string,
  body: string | undefined,
  isBase64Encoded: boolean,
  cookies: Array<string> | undefined,
): APIGatewayProxyEventV2 => ({
  version: "2.0",
  routeKey: `${method} ${path}`,
  rawPath: path,
  rawQueryString,
  ...(cookies === undefined ? {} : { cookies }),
  headers: { ...headers },
  requestContext: {
    accountId: "123456789012",
    apiId: "mcp-http-api",
    domainName: CONFIG.canonicalHost,
    domainPrefix: "mcp",
    http: {
      method,
      path,
      protocol: "HTTP/1.1",
      sourceIp: "203.0.113.10",
      userAgent: "mcp-handler-test",
    },
    requestId: "request-1",
    routeKey: `${method} ${path}`,
    stage: "$default",
    time: "14/Aug/2026:12:00:00 +0000",
    timeEpoch: 1_776_165_600_000,
  },
  ...(body === undefined ? {} : { body }),
  isBase64Encoded,
});

test("MCP HTTP API v2 adapter preserves raw path, query, cookies, and base64 request bodies", async (): Promise<void> => {
  const event = createHttpApiV2Event(
    "POST",
    "/mcp",
    {
      host: CONFIG.canonicalHost,
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    "workspace=one%20two&workspace=three",
    Buffer.from('{"jsonrpc":"2.0"}', "utf8").toString("base64"),
    true,
    ["first=one", "second=two"],
  );

  const request = createMcpRequestFromHttpApiV2Event(event);

  assert.equal(request.method, "POST");
  assert.equal(
    request.url,
    "https://mcp.example.com/mcp?workspace=one%20two&workspace=three",
  );
  assert.equal(request.headers.get("cookie"), "first=one; second=two");
  assert.equal(request.headers.get("x-forwarded-for"), "203.0.113.10");
  assert.equal(await request.text(), '{"jsonrpc":"2.0"}');
});

test("MCP HTTP API v2 adapter rejects non-v2 and inconsistent route events", (): void => {
  const event = createHttpApiV2Event(
    "GET",
    "/mcp",
    { host: CONFIG.canonicalHost },
    "",
    undefined,
    false,
    undefined,
  );

  assert.throws(
    () => createMcpRequestFromHttpApiV2Event({ ...event, version: "1.0" }),
    McpHttpApiV2EventError,
  );
  assert.throws(
    () => createMcpRequestFromHttpApiV2Event({ ...event, routeKey: "GET /other" }),
    McpHttpApiV2EventError,
  );
});

test("MCP HTTP API v2 adapter emits structured status, headers, cookies, and buffered body", async (): Promise<void> => {
  const headers = new Headers({ "content-type": "application/json", "x-request-id": "request-1" });
  headers.append("set-cookie", "first=one; Secure");
  headers.append("set-cookie", "second=two; Secure");
  const response = new Response('{"error":"invalid_token"}', { status: 401, headers });

  const result = await createHttpApiV2ResultFromMcpResponse(response);

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.headers, {
    "content-type": "application/json",
    "x-request-id": "request-1",
  });
  assert.deepEqual(result.cookies, ["first=one; Secure", "second=two; Secure"]);
  assert.equal(result.body, '{"error":"invalid_token"}');
  assert.equal(result.isBase64Encoded, false);
});

test("MCP Lambda handler consumes HTTP API v2 metadata events without REST aliases", async (): Promise<void> => {
  const handler = createMcpHandler(createDependencies(async () => CONNECTION, []));
  const metadata = await handler(createHttpApiV2Event(
    "GET",
    "/.well-known/oauth-protected-resource/mcp",
    { host: CONFIG.canonicalHost },
    "",
    undefined,
    false,
    undefined,
  ));

  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(JSON.parse(metadata.body ?? ""), {
    resource: RESOURCE,
    authorization_servers: [CONFIG.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["expenses:read", "expenses:write"],
    resource_documentation: "https://expense-budget-tracker.com/docs/mcp-connector/",
  });
});

test("MCP Lambda preserves OAuth challenge headers in an HTTP API v2 response", async (): Promise<void> => {
  const handler = createMcpHandler(createDependencies(async () => CONNECTION, []));
  const response = await handler(createHttpApiV2Event(
    "POST",
    "/mcp",
    { host: CONFIG.canonicalHost },
    "",
    undefined,
    false,
    undefined,
  ));

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers?.["www-authenticate"], `Bearer resource_metadata="${METADATA_URL}"`);
  assert.equal(response.isBase64Encoded, false);
});

test("MCP Lambda starts one absolute deadline at HTTP API request entry before OAuth", async (): Promise<void> => {
  const steps: Array<string> = [];
  let authenticationDeadline: SqlExecutionDeadline | undefined;
  const dependencies = createDependencies(async (_token, _resource, deadline) => {
    steps.push("authenticate");
    authenticationDeadline = deadline;
    throw new McpAuthenticationError();
  }, []);
  const handler = createMcpHandler({
    ...dependencies,
    now: () => {
      steps.push("deadline");
      return 10_000;
    },
  });

  const response = await handler(createHttpApiV2Event(
    "POST",
    "/mcp",
    authenticatedHeaders(),
    "",
    undefined,
    false,
    undefined,
  ));

  assert.equal(response.statusCode, 401);
  assert.deepEqual(steps, ["deadline", "authenticate"]);
  assert.equal(authenticationDeadline?.expiresAtMs, 10_000 + MCP_SQL_STATEMENT_TIMEOUT_MS);
});

test("MCP handler serves only the pathful protected-resource metadata location", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(async () => CONNECTION, logEvents));

  const response = await app.request(METADATA_URL);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    resource: RESOURCE,
    authorization_servers: [CONFIG.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["expenses:read", "expenses:write"],
    resource_documentation: "https://expense-budget-tracker.com/docs/mcp-connector/",
  });
  assert.deepEqual(logEvents, []);
});

test("MCP handler does not serve removed, unknown, or /v1 routes", async (): Promise<void> => {
  let authenticationCalls = 0;
  const app = createMcpApp(createDependencies(async () => {
    authenticationCalls += 1;
    return CONNECTION;
  }, []));

  for (const path of [
    "/health",
    "/.well-known/oauth-protected-resource",
    "/unknown",
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
    (token, resource, deadline) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      deadline,
      {
        queryBeforeDeadline: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: CONNECTION.clientId,
          resource: RESOURCE,
          scopes: CONNECTION.scopes,
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentityBeforeDeadline: async () => disabledIdentity,
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

test("MCP handler maps a readonly authentication transaction deadline to retryable 504", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(async () => {
    throw new SqlTransactionOutcomeUnknownError(
      "commit",
      new SqlExecutionDeadlineError(MCP_SQL_STATEMENT_TIMEOUT_MS),
      "unknown",
      undefined,
    );
  }, logEvents));

  const response = await app.request(RESOURCE, {
    method: "POST",
    headers: authenticatedHeaders(),
  });

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "request_deadline_exceeded",
    error_description: "The MCP request exceeded its 20-second total execution deadline. Retry the request.",
  });
  assert.deepEqual(logEvents, []);
});

test("MCP handler maps invalid scope snapshots to the generic Bearer challenge", async (): Promise<void> => {
  const logEvents: Array<SqlApiLogEvent> = [];
  const app = createMcpApp(createDependencies(
    (token, resource, deadline) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      deadline,
      {
        queryBeforeDeadline: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: CONNECTION.clientId,
          resource: RESOURCE,
          scopes: ["expenses:write", "expenses:read"],
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentityBeforeDeadline: async () => CONNECTION.identity,
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
    (token, resource, deadline) => authenticateMcpAccessTokenWithDependencies(
      token,
      resource,
      deadline,
      {
        queryBeforeDeadline: async () => createQueryResult([{
          connection_id: CONNECTION.connectionId,
          user_id: CONNECTION.identity.userId,
          client_id: 42,
          resource: RESOURCE,
          scopes: CONNECTION.scopes,
          expires_at: new Date("2026-08-14T13:00:00.000Z"),
        }]),
        loadTrustedUserIdentityBeforeDeadline: async () => CONNECTION.identity,
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

test("MCP handler preserves authenticated GET protocol behavior without exposing other methods", async (): Promise<void> => {
  let authenticationCalls = 0;
  const app = createMcpApp(createDependencies(async () => {
    authenticationCalls += 1;
    return CONNECTION;
  }, []));

  const get = await app.request(RESOURCE, {
    method: "GET",
    headers: authenticatedHeaders(),
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const deleted = await app.request(RESOURCE, {
    method: "DELETE",
    headers: authenticatedHeaders(),
  });
  assert.equal(deleted.status, 404);
  assert.equal(authenticationCalls, 1);
});

test("MCP handler uses stateless JSON transport with no session identifier", async (): Promise<void> => {
  let serverCreations = 0;
  const authenticationDeadlines: Array<SqlExecutionDeadline> = [];
  const serverDeadlines: Array<SqlExecutionDeadline> = [];
  const dependencies = createDependencies(async (token, resource, deadline) => {
    assert.equal(token, ACCESS_TOKEN);
    assert.equal(resource, RESOURCE);
    authenticationDeadlines.push(deadline);
    return CONNECTION;
  }, []);
  const app = createMcpApp({
    ...dependencies,
    createMcpServer: (connection, deadline) => {
      serverCreations += 1;
      serverDeadlines.push(deadline);
      return createMcpServer(connection, deadline);
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
  assert.equal(serverDeadlines[0], authenticationDeadlines[0]);
  assert.equal(serverDeadlines[1], authenticationDeadlines[1]);
  assert.deepEqual(
    authenticationDeadlines.map((deadline) => deadline.timeoutMs),
    [MCP_SQL_STATEMENT_TIMEOUT_MS, MCP_SQL_STATEMENT_TIMEOUT_MS],
  );
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
