import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { QueryResult } from "pg";
import { buildAgentDiscoveryEnvelope } from "../../web/src/server/agentDiscoveryContract";
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

test("root discovery matches the shared discovery contract", async () => {
  const handler = createMachineApiHandler({
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
  });

  const response = await handler(createEvent({ path: "/", resource: "/" }));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    JSON.parse(response.body),
    buildAgentDiscoveryEnvelope({
      apiBaseUrl: "https://api.example.com/v1",
      authBaseUrl: "https://auth.example.com",
      bootstrapUrl: "https://auth.example.com/api/agent/send-code",
    }),
  );
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
  let savedWorkspaceId: string | null = null;

  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("UPDATE auth.agent_api_keys")) {
        savedWorkspaceId = String(params[0]);
        return createQueryResult([{ connection_id: "connection-1" }]) as never;
      }
      if (text.includes("SELECT selected_workspace_id")) {
        return createQueryResult([{ selected_workspace_id: savedWorkspaceId }]) as never;
      }
      if (text.includes("FROM information_schema.columns")) {
        return createQueryResult([
          {
            table_name: "accounts",
            column_name: "account_id",
            data_type: "text",
            udt_name: "text",
            is_nullable: "NO",
            column_default: null,
          },
        ]) as never;
      }
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
  const schemaResponse = await handler(createAuthenticatedEvent({ path: "/schema", resource: "/schema" }));
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
    },
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(meResponse.statusCode, 200);
  assert.equal(workspacesResponse.statusCode, 200);
  assert.equal(schemaResponse.statusCode, 200);
  assert.equal(createWorkspaceResponse.statusCode, 200);
  assert.equal(selectWorkspaceResponse.statusCode, 200);
  assert.equal(sqlResponse.statusCode, 200);

  assert.equal(JSON.parse(meResponse.body).ok, true);
  assert.equal(JSON.parse(workspacesResponse.body).ok, true);
  assert.equal(JSON.parse(schemaResponse.body).ok, true);
  assert.equal(JSON.parse(createWorkspaceResponse.body).ok, true);
  assert.equal(JSON.parse(selectWorkspaceResponse.body).ok, true);
  assert.equal(JSON.parse(sqlResponse.body).ok, true);
  assert.deepEqual(
    (JSON.parse(meResponse.body).actions as Array<{ name: string }>).map((action) => action.name),
    ["list_workspaces", "select_workspace", "schema"],
  );
});

test("sql without header and without saved workspace returns missing_workspace_id", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text) => {
      if (text.includes("SELECT selected_workspace_id")) {
        return createQueryResult([{ selected_workspace_id: null }]) as never;
      }
      if (text.includes("FROM workspaces w") && text.includes("ORDER BY w.name")) {
        return createQueryResult([
          { workspace_id: "workspace-1", name: "Main" },
          { workspace_id: "workspace-2", name: "Side" },
        ]) as never;
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("SQL should not execute when workspace is missing");
    },
  });

  const sqlResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
    },
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(sqlResponse.statusCode, 400);
  assert.equal(JSON.parse(sqlResponse.body).error.code, "missing_workspace_id");
});

test("sql without header auto-selects when only one workspace exists", async () => {
  let savedWorkspaceId: string | null = null;

  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("SELECT selected_workspace_id")) {
        return createQueryResult([{ selected_workspace_id: null }]) as never;
      }
      if (text.includes("FROM workspaces w") && text.includes("ORDER BY w.name")) {
        return createQueryResult([{ workspace_id: "workspace-1", name: "Main" }]) as never;
      }
      if (text.includes("UPDATE auth.agent_api_keys")) {
        savedWorkspaceId = String(params[0]);
        return createQueryResult([{ connection_id: "connection-1" }]) as never;
      }
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([{ workspace_id: String(params[0]), name: "Main" }]) as never;
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async (_identity, workspaceId, _timeoutMs, callback) => {
      assert.equal(workspaceId, "workspace-1");
      return callback(async () => createQueryResult([{ account_id: "checking" }]));
    },
  });

  const sqlResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
    },
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(sqlResponse.statusCode, 200);
  assert.equal(savedWorkspaceId, "workspace-1");
});

test("relation_not_allowed for information_schema points clients to /schema", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([{ workspace_id: String(params[0]), name: "Main" }]) as never;
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("Policy should reject relation before execution");
    },
  });

  const sqlResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
      "X-Workspace-Id": "workspace-1",
    },
    body: JSON.stringify({ sql: "SELECT * FROM information_schema.columns LIMIT 1" }),
  }));

  assert.equal(sqlResponse.statusCode, 400);
  const payload = JSON.parse(sqlResponse.body) as { error: { code: string }; instructions: string };
  assert.equal(payload.error.code, "relation_not_allowed");
  assert.match(payload.instructions, /\/schema/);
  assert.match(payload.instructions, /System catalogs are not queryable/i);
});

test("unsupported_statement returns actionable transaction guidance", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([{ workspace_id: String(params[0]), name: "Main" }]) as never;
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("Policy should reject statement before execution");
    },
  });

  const sqlResponse = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
      "X-Workspace-Id": "workspace-1",
    },
    body: JSON.stringify({ sql: "BEGIN" }),
  }));

  assert.equal(sqlResponse.statusCode, 400);
  const payload = JSON.parse(sqlResponse.body) as { error: { code: string }; instructions: string };
  assert.equal(payload.error.code, "unsupported_statement");
  assert.match(payload.instructions, /BEGIN\/COMMIT\/ROLLBACK/i);
});
