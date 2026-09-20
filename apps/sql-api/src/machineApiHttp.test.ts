import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type { AgentApiKeyContext } from "./agentApiKeyAuth.js";
import {
  createMachineApiFetch,
  createProxyEventFromRequest,
  createResponseFromProxyResult,
} from "./machineApiHttp.js";
import { MAX_REQUEST_BODY_BYTES, RequestBodyTooLargeError } from "./requestBodyLimit.js";

const AUTHENTICATED: AgentApiKeyContext = {
  userId: "user-1",
  email: "user@example.com",
  connectionId: "connection-1",
  label: "codex-desktop",
  createdAt: "2026-03-10T00:00:00.000Z",
  lastUsedAt: "",
};

const okResult: APIGatewayProxyResult = {
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true }),
};

test("converts a GET request into a payload version 1 event", async () => {
  const request = new Request("http://api.example.com/v1/workspaces?limit=5&limit=7&cursor=abc", {
    headers: { host: "api.example.com", "x-workspace-id": "workspace-1" },
  });

  const event = await createProxyEventFromRequest(request, AUTHENTICATED);

  assert.equal(event.httpMethod, "GET");
  assert.equal(event.path, "/v1/workspaces");
  assert.equal(event.body, null);
  assert.equal(event.isBase64Encoded, false);
  assert.equal(event.pathParameters, null);
  assert.equal(event.headers["host"], "api.example.com");
  assert.equal(event.headers["x-workspace-id"], "workspace-1");
  assert.deepEqual(event.queryStringParameters, { limit: "7", cursor: "abc" });
  assert.deepEqual(event.multiValueQueryStringParameters, { limit: ["5", "7"], cursor: ["abc"] });
  assert.deepEqual(event.multiValueHeaders["x-workspace-id"], ["workspace-1"]);
  assert.equal(event.requestContext.httpMethod, "GET");
  assert.equal(event.requestContext.path, "/v1/workspaces");
});

test("converts a POST body and keeps a request without a query string null", async () => {
  const request = new Request("http://api.example.com/v1/sql/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT 1" }),
  });

  const event = await createProxyEventFromRequest(request, AUTHENTICATED);

  assert.equal(event.httpMethod, "POST");
  assert.equal(event.path, "/v1/sql/query");
  assert.equal(event.body, JSON.stringify({ sql: "SELECT 1" }));
  assert.equal(event.queryStringParameters, null);
  assert.equal(event.multiValueQueryStringParameters, null);
});

test("resolves the workspace select path parameter", async () => {
  const request = new Request("http://api.example.com/v1/workspaces/workspace-1/select", { method: "POST" });

  const event = await createProxyEventFromRequest(request, AUTHENTICATED);

  assert.deepEqual(event.pathParameters, { workspaceId: "workspace-1" });
});

test("fills the authorizer context with the keys the machine API reads", async () => {
  const request = new Request("http://api.example.com/v1/me");

  const event = await createProxyEventFromRequest(request, AUTHENTICATED);

  assert.deepEqual(event.requestContext.authorizer, {
    userId: "user-1",
    email: "user@example.com",
    connectionId: "connection-1",
    label: "codex-desktop",
    createdAt: "2026-03-10T00:00:00.000Z",
    lastUsedAt: "",
  });
});

test("leaves the authorizer context empty for an unauthenticated request", async () => {
  const request = new Request("http://api.example.com/v1/me");

  const event = await createProxyEventFromRequest(request, null);

  assert.deepEqual(event.requestContext.authorizer, {});
});

test("converts a proxy result back into a response", async () => {
  const response = createResponseFromProxyResult({
    statusCode: 401,
    headers: { "content-type": "application/json" },
    multiValueHeaders: { "set-cookie": ["a=1", "b=2"] },
    body: JSON.stringify({ error: "missing_api_key" }),
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(response.headers.getSetCookie(), ["a=1", "b=2"]);
  assert.equal(await response.text(), JSON.stringify({ error: "missing_api_key" }));
});

test("decodes a base64 encoded proxy result body", async () => {
  const response = createResponseFromProxyResult({
    statusCode: 200,
    body: Buffer.from("plain text", "utf8").toString("base64"),
    isBase64Encoded: true,
  });

  assert.equal(await response.text(), "plain text");
});

test("returns a body-less response for a null body status", async () => {
  const response = createResponseFromProxyResult({ statusCode: 204, body: "" });

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
});

test("authenticates the request before handing it to the machine API handler", async () => {
  const events: Array<APIGatewayProxyEvent> = [];
  const authorizations: Array<string> = [];
  const fetch = createMachineApiFetch({
    handleEvent: async (event) => {
      events.push(event);
      return okResult;
    },
    validateAuthorization: async (authorization) => {
      authorizations.push(authorization);
      return AUTHENTICATED;
    },
  });

  const response = await fetch(new Request("http://api.example.com/v1/me", {
    headers: { authorization: "ApiKey EBTA_ABCDEFGH_ABCDEFGHJKMNPQRSTVWXYZ0123" },
  }));

  assert.deepEqual(authorizations, ["ApiKey EBTA_ABCDEFGH_ABCDEFGHJKMNPQRSTVWXYZ0123"]);
  assert.equal(events[0]?.path, "/v1/me");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), JSON.stringify({ ok: true }));
});

test("passes an unauthenticated request to the handler so it answers 401", async () => {
  const events: Array<APIGatewayProxyEvent> = [];
  const fetch = createMachineApiFetch({
    handleEvent: async (event) => {
      events.push(event);
      return { statusCode: 401, headers: { "content-type": "application/json" }, body: "{}" };
    },
    validateAuthorization: async () => null,
  });

  const response = await fetch(new Request("http://api.example.com/v1/me"));

  assert.deepEqual(events[0]?.requestContext.authorizer, {});
  assert.equal(response.status, 401);
});

test("does not read the body of an unauthenticated non-discovery request", async () => {
  const request = new Request("http://api.example.com/v1/sql/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT 1" }),
  });

  const event = await createProxyEventFromRequest(request, null);

  assert.equal(event.body, null);
  assert.equal(request.bodyUsed, false);
});

test("rejects a body whose declared length exceeds the limit before reading it", async () => {
  const events: Array<APIGatewayProxyEvent> = [];
  const fetch = createMachineApiFetch({
    handleEvent: async (event) => {
      events.push(event);
      return okResult;
    },
    validateAuthorization: async () => AUTHENTICATED,
  });

  const request = new Request("http://api.example.com/v1/sql/execute", {
    method: "POST",
    headers: {
      authorization: "ApiKey EBTA_ABCDEFGH_ABCDEFGHJKMNPQRSTVWXYZ0123",
      "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
    },
    body: JSON.stringify({ sql: "SELECT 1" }),
  });

  const response = await fetch(request);
  const payload = await response.json() as {
    ok: boolean;
    data: { maxRequestBodyBytes: number };
    error: { code: string; message: string };
    instructions: string;
  };

  assert.equal(response.status, 413);
  assert.deepEqual(events, []);
  assert.equal(request.bodyUsed, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "payload_too_large");
  assert.equal(payload.data.maxRequestBodyBytes, MAX_REQUEST_BODY_BYTES);
  assert.equal(
    payload.instructions,
    `Send a request body of at most ${String(MAX_REQUEST_BODY_BYTES)} bytes.`,
  );
});

test("rejects a streamed body on the chunk that crosses the limit and stops reading", async () => {
  // A request body without a declared Content-Length is bounded while it is
  // streamed, so the limit holds even when the client declares nothing. Two
  // chunks of this size cross the ceiling, and the stream never ends: a guard
  // that drained the body instead of cancelling it would never return.
  const chunk = new Uint8Array(Math.floor(MAX_REQUEST_BODY_BYTES / 2) + 1).fill(0x78);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel: () => {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  const request = new Request("http://api.example.com/v1/sql/execute", {
    method: "POST",
    body,
    duplex: "half",
  });
  assert.equal(request.headers.get("content-length"), null);

  await assert.rejects(
    () => createProxyEventFromRequest(request, AUTHENTICATED),
    RequestBodyTooLargeError,
  );

  assert.equal(pulls, 2);
  assert.equal(cancelled, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pulls, 2);
});
