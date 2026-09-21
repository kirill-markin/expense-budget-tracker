import assert from "node:assert/strict";
import test from "node:test";

import {
  postAgentConnectionRouteWithDeps,
  type CreateAgentConnectionDependencies,
} from "@/app/api/agent-connections/route";
import type { AuthMode } from "@/server/authMode";
import {
  MAX_ACTIVE_API_KEY_CONNECTIONS,
  type CreateApiKeyConnectionResult,
} from "@/server/agent/connections";

const createRequest = (body: unknown): Request =>
  new Request("http://localhost/api/agent-connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
    body: JSON.stringify(body),
  });

const createDependencies = (
  authMode: AuthMode,
  calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>>,
  result: CreateApiKeyConnectionResult = {
    kind: "created",
    connection: {
      connectionId: "connection-1",
      label: "Claude Code",
      createdAt: "2026-09-21T09:00:00.000Z",
      apiKey: "ebta_ABCDEFGH_ABCDEFGHJKMNPQRSTVWXYZ0123",
    },
  },
): CreateAgentConnectionDependencies => ({
  getAuthMode: (): AuthMode => authMode,
  createApiKeyConnection: async (
    userId: string,
    workspaceId: string,
    label: string,
  ): Promise<CreateApiKeyConnectionResult> => {
    calls.push({ userId, workspaceId, label });
    return result;
  },
});

test("postAgentConnectionRouteWithDeps mints a key for the proxy-authenticated user", async (): Promise<void> => {
  const calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>> = [];
  const response = await postAgentConnectionRouteWithDeps(
    createRequest({ label: "Claude Code" }),
    createDependencies("proxy_jwt", calls),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    connection: {
      connectionId: "connection-1",
      label: "Claude Code",
      createdAt: "2026-09-21T09:00:00.000Z",
    },
    apiKey: "ebta_ABCDEFGH_ABCDEFGHJKMNPQRSTVWXYZ0123",
    instructions: "Copy this API key now: it is stored hashed and is never shown again. Send it as \"Authorization: ApiKey <key>\" to the /v1 machine API.",
  });
  assert.deepEqual(calls, [{ userId: "user-1", workspaceId: "workspace-1", label: "Claude Code" }]);
});

test("postAgentConnectionRouteWithDeps refuses to create a key in cognito mode", async (): Promise<void> => {
  const calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>> = [];
  const response = await postAgentConnectionRouteWithDeps(
    createRequest({ label: "Claude Code" }),
    createDependencies("cognito", calls),
  );

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/u);
  assert.match(await response.text(), /requires AUTH_MODE=proxy_jwt/u);
  assert.deepEqual(calls, [], "cognito must keep the email code flow as its only issuing path");
});

test("postAgentConnectionRouteWithDeps refuses to create a key in none mode", async (): Promise<void> => {
  const calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>> = [];
  const response = await postAgentConnectionRouteWithDeps(
    createRequest({ label: "Claude Code" }),
    createDependencies("none", calls),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test("postAgentConnectionRouteWithDeps rejects a blank label", async (): Promise<void> => {
  const calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>> = [];
  const response = await postAgentConnectionRouteWithDeps(
    createRequest({ label: "   " }),
    createDependencies("proxy_jwt", calls),
  );

  assert.equal(response.status, 400);
  // The settings UI renders the body with response.text(), like the revoke
  // route it sits next to, so an error body must be readable plain text.
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/u);
  assert.match(await response.text(), /Invalid label/u);
  assert.deepEqual(calls, []);
});

test("postAgentConnectionRouteWithDeps refuses over the active key cap and names it", async (): Promise<void> => {
  const calls: Array<Readonly<{ userId: string; workspaceId: string; label: string }>> = [];
  const response = await postAgentConnectionRouteWithDeps(
    createRequest({ label: "Claude Code" }),
    createDependencies("proxy_jwt", calls, {
      kind: "refused_active_limit",
      activeCount: MAX_ACTIVE_API_KEY_CONNECTIONS,
      limit: MAX_ACTIVE_API_KEY_CONNECTIONS,
    }),
  );

  assert.equal(response.status, 409);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/u);
  const body = await response.text();
  assert.match(body, new RegExp(`limit of ${String(MAX_ACTIVE_API_KEY_CONNECTIONS)} per user`, "u"));
  assert.match(body, /Revoke a key you no longer use/u);
  assert.deepEqual(calls, [{ userId: "user-1", workspaceId: "workspace-1", label: "Claude Code" }]);
});
