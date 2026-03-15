import assert from "node:assert/strict";
import test from "node:test";
import { createMachineApiHandler } from "./machineApi.js";
import { createAuthenticatedEvent, createEvent, createQueryResult } from "./handlerTestUtils.js";

test("authenticated workspace routes return envelopes on canonical v1 paths", async () => {
  let savedWorkspaceId: string | null = null;

  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text, params) => {
      if (text.includes("UPDATE auth.agent_api_keys")) {
        savedWorkspaceId = String(params[0]);
        return createQueryResult([{ connection_id: "connection-1" }]) as never;
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

  assert.equal(meResponse.statusCode, 200);
  assert.equal(workspacesResponse.statusCode, 200);
  assert.equal(schemaResponse.statusCode, 200);
  assert.equal(createWorkspaceResponse.statusCode, 200);
  assert.equal(selectWorkspaceResponse.statusCode, 200);
  assert.equal(JSON.parse(meResponse.body).ok, true);
  assert.equal(JSON.parse(workspacesResponse.body).ok, true);
  assert.equal(JSON.parse(schemaResponse.body).ok, true);
  assert.equal(JSON.parse(createWorkspaceResponse.body).ok, true);
  assert.equal(JSON.parse(selectWorkspaceResponse.body).ok, true);
  assert.equal(savedWorkspaceId, "workspace-1");
  assert.deepEqual(
    (JSON.parse(meResponse.body).actions as Array<{ name: string }>).map((action) => action.name),
    ["list_workspaces", "select_workspace", "schema"],
  );
});

test("authenticated routes require api key auth", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => createQueryResult([]) as never,
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createEvent({ path: "/workspaces", resource: "/workspaces" }));

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error.code, "missing_api_key");
});

test("workspace creation rejects invalid json", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => createQueryResult([]) as never,
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/workspaces",
    resource: "/workspaces",
    body: "{bad-json",
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "invalid_request");
});

test("workspace creation rejects blank name", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => createQueryResult([]) as never,
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/workspaces",
    resource: "/workspaces",
    body: JSON.stringify({ name: "   " }),
  }));

  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error.code, "invalid_workspace_name");
});

test("workspace select returns workspace_not_found when workspace is missing", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => Promise.resolve(),
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async (_identity, _workspaceId, text) => {
      if (text.includes("WHERE w.workspace_id = $1")) {
        return createQueryResult([]) as never;
      }

      throw new Error(`Unexpected SQL: ${text}`);
    },
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const response = await handler(createAuthenticatedEvent({
    httpMethod: "POST",
    path: "/workspaces/workspace-1/select",
    resource: "/workspaces/{workspaceId}/select",
    pathParameters: { workspaceId: "workspace-1" },
  }));

  assert.equal(response.statusCode, 404);
  assert.equal(JSON.parse(response.body).error.code, "workspace_not_found");
});

test("workspace routes surface retryable internal failures with route-specific codes", async () => {
  const handler = createMachineApiHandler({
    ensureTrustedIdentityProvisioned: async () => {
      throw new Error("provision failed");
    },
    loadOpenApiDocument: () => ({ openapi: "3.1.0" }),
    queryAsTrustedIdentity: async () => {
      throw new Error("db failed");
    },
    withRestrictedTrustedIdentityContext: async () => createQueryResult([]) as never,
  });

  const meResponse = await handler(createAuthenticatedEvent({ path: "/me", resource: "/me" }));
  const workspacesResponse = await handler(createAuthenticatedEvent({ path: "/workspaces", resource: "/workspaces" }));

  assert.equal(meResponse.statusCode, 500);
  assert.equal(workspacesResponse.statusCode, 500);
  assert.equal(JSON.parse(meResponse.body).error.code, "agent_me_failed");
  assert.equal(JSON.parse(workspacesResponse.body).error.code, "agent_workspaces_failed");
});
