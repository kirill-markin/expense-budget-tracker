import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { createBoundedMcpFetch } from "./mcpHttp.js";
import { MAX_REQUEST_BODY_BYTES } from "./requestBodyLimit.js";

type ReceivedRequest = Readonly<{
  method: string;
  url: string;
  host: string | null;
  contentType: string | null;
  body: string;
}>;

const createRecordingApp = (received: Array<ReceivedRequest>): Hono => {
  const app = new Hono();
  app.all("*", async (context) => {
    const request = context.req.raw;
    received.push({
      method: request.method,
      url: request.url,
      host: request.headers.get("host"),
      contentType: request.headers.get("content-type"),
      body: request.method === "GET" ? "" : await request.text(),
    });
    return context.json({ ok: true });
  });
  return app;
};

test("hands a bounded request to the MCP app with its method, url, headers and body intact", async () => {
  const received: Array<ReceivedRequest> = [];
  const fetch = createBoundedMcpFetch(createRecordingApp(received));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  const response = await fetch(new Request("http://mcp.example.com/mcp", {
    method: "POST",
    headers: { host: "mcp.example.com", "content-type": "application/json" },
    body,
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(received, [{
    method: "POST",
    url: "http://mcp.example.com/mcp",
    host: "mcp.example.com",
    contentType: "application/json",
    body,
  }]);
});

test("forwards a request without a body unchanged", async () => {
  const received: Array<ReceivedRequest> = [];
  const fetch = createBoundedMcpFetch(createRecordingApp(received));

  const response = await fetch(new Request("http://mcp.example.com/.well-known/oauth-protected-resource/mcp", {
    headers: { host: "mcp.example.com" },
  }));

  assert.equal(response.status, 200);
  assert.equal(received[0]?.method, "GET");
});

test("rejects a body whose declared length exceeds the limit before the MCP app runs", async () => {
  const received: Array<ReceivedRequest> = [];
  const fetch = createBoundedMcpFetch(createRecordingApp(received));

  const response = await fetch(new Request("http://mcp.example.com/mcp", {
    method: "POST",
    headers: {
      host: "mcp.example.com",
      "content-type": "application/json",
      "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  const payload = await response.json() as { error: string; error_description: string };

  assert.equal(response.status, 413);
  assert.deepEqual(received, []);
  assert.equal(payload.error, "payload_too_large");
  assert.equal(
    payload.error_description,
    `The MCP request body must not exceed ${String(MAX_REQUEST_BODY_BYTES)} bytes.`,
  );
});

test("rejects a streamed body on the chunk that crosses the limit and stops reading", async () => {
  const received: Array<ReceivedRequest> = [];
  const fetch = createBoundedMcpFetch(createRecordingApp(received));
  // Two chunks of this size cross the ceiling, and the stream never ends: a
  // guard that drained the body instead of cancelling it would never return.
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

  const response = await fetch(new Request("http://mcp.example.com/mcp", {
    method: "POST",
    headers: { host: "mcp.example.com", "content-type": "application/json" },
    body,
    duplex: "half",
  }));

  assert.equal(response.status, 413);
  assert.deepEqual(received, []);
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pulls, 2);
});
