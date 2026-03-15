import assert from "node:assert/strict";
import test from "node:test";
import { createMachineApiHandler } from "./machineApi.js";
import { createAuthenticatedEvent, createQueryResult } from "./handlerTestUtils.js";

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

test("sql rejects invalid json", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => createQueryResult([]) as never,
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    body: "{bad-json",
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "invalid_request");
});

test("sql rejects blank sql", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => createQueryResult([]) as never,
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    body: JSON.stringify({ sql: "   " }),
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "missing_sql");
});

test("sql returns workspace_not_found when selected workspace is missing", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text) => {
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([]) as never;
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("SQL should not execute when workspace is missing");
    },
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    headers: {
      Host: "api.example.com",
      "X-Workspace-Id": "workspace-1",
    },
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "workspace_not_found");
});

test("sql surfaces retryable internal failures with agent_sql_failed", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => {
      throw new Error("workspace lookup failed");
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("unexpected");
    },
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/sql",
    resource: "/sql",
    body: JSON.stringify({ sql: "SELECT * FROM accounts LIMIT 1" }),
  }));

  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error.code, "agent_sql_failed");
});
