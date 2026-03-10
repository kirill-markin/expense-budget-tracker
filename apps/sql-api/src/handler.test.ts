import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { QueryResult } from "pg";
import { createMachineApiHandler } from "./machineApi";

const createQueryResult = (rows: ReadonlyArray<unknown>): QueryResult =>
  ({
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  }) as QueryResult;

const createEvent = (
  overrides: Partial<APIGatewayProxyEvent>,
): APIGatewayProxyEvent => ({
  body: null,
  headers: { Host: "api.example.com" },
  multiValueHeaders: {},
  httpMethod: "GET",
  isBase64Encoded: false,
  path: "/",
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  resource: "/",
  requestContext: {
    accountId: "123456789012",
    apiId: "api-id",
    authorizer: undefined,
    protocol: "HTTP/1.1",
    httpMethod: "GET",
    identity: {} as APIGatewayProxyEvent["requestContext"]["identity"],
    path: "/",
    stage: "v1",
    requestId: "request-id",
    requestTimeEpoch: 0,
    resourceId: "resource-id",
    resourcePath: "/",
  },
  ...overrides,
});

const createAuthenticatedEvent = (
  overrides: Partial<APIGatewayProxyEvent>,
): APIGatewayProxyEvent => createEvent({
  requestContext: {
    ...createEvent({}).requestContext,
    authorizer: {
      userId: "user-1",
      email: "user@example.com",
      connectionId: "connection-1",
      label: "codex-desktop",
      createdAt: "2026-03-10T00:00:00.000Z",
      lastUsedAt: "",
    },
  },
  ...overrides,
});

test("root discovery matches /agent", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
  });

  const rootResponse = await handler(createEvent({ path: "/", resource: "/" }));
  const agentResponse = await handler(createEvent({ path: "/agent", resource: "/agent" }));

  assert.equal(rootResponse.statusCode, 200);
  assert.equal(agentResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(rootResponse.body), JSON.parse(agentResponse.body));

  const body = JSON.parse(rootResponse.body) as { instructions: string };
  assert.match(body.instructions, /Ask the user for their email address first/i);
  assert.match(body.instructions, /same email OTP flow handles both signup and login/i);
  assert.match(body.instructions, /\.env file as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>'/i);
  assert.match(body.instructions, /Authorization: ApiKey \$EXPENSE_BUDGET_TRACKER_API_KEY/);
});

test("openapi and swagger endpoints return the same document", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0", info: { title: "Expense API" } }),
  });

  const openapiResponse = await handler(createEvent({ path: "/openapi.json", resource: "/openapi.json" }));
  const swaggerResponse = await handler(createEvent({ path: "/swagger.json", resource: "/swagger.json" }));

  assert.equal(openapiResponse.statusCode, 200);
  assert.equal(swaggerResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(openapiResponse.body), JSON.parse(swaggerResponse.body));
});

test("authenticated machine routes return envelopes on canonical v1 paths", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("FROM workspaces w") && text.includes("ORDER BY w.name")) {
        return createQueryResult([{ workspace_id: "workspace-1", name: "Main" }]) as never;
      }
      if (text.includes("create_workspace_for_current_user")) {
        return createQueryResult([{ workspace_id: "workspace-2", name: String(params[0]) }]) as never;
      }
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([{ workspace_id: String(params[0]), name: "Main" }]) as never;
      }

      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async (_identity, _workspaceId, _timeoutMs, callback) =>
      callback(async () => createQueryResult([{ account_id: "checking" }])),
  });

  const meResponse = await handler(createAuthenticatedEvent({ path: "/me", resource: "/me" }));
  const workspacesResponse = await handler(createAuthenticatedEvent({ path: "/workspaces", resource: "/workspaces" }));
  const createWorkspaceResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/workspaces",
    resource: "/workspaces",
    body: JSON.stringify({ name: "Trips" }),
  }));
  const selectWorkspaceResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/workspaces/workspace-1/select",
    resource: "/workspaces/{workspaceId}/select",
    pathParameters: { workspaceId: "workspace-1" },
  }));
  const sqlResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
      "X-Workspace-Id": "workspace-1",
    },
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(meResponse.statusCode, 200);
  assert.equal(workspacesResponse.statusCode, 200);
  assert.equal(createWorkspaceResponse.statusCode, 200);
  assert.equal(selectWorkspaceResponse.statusCode, 200);
  assert.equal(sqlResponse.statusCode, 200);

  assert.equal(JSON.parse(meResponse.body).ok, true);
  assert.equal(JSON.parse(workspacesResponse.body).ok, true);
  assert.equal(JSON.parse(createWorkspaceResponse.body).ok, true);
  assert.equal(JSON.parse(selectWorkspaceResponse.body).ok, true);
  assert.equal(JSON.parse(sqlResponse.body).ok, true);
});
