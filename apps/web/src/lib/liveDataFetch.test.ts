import assert from "node:assert/strict";
import test from "node:test";

import { fetchLiveData } from "./liveDataFetch";

test("fetchLiveData disables browser caching for live workspace reads", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Readonly<{ input: RequestInfo | URL; init: RequestInit | undefined }>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await fetchLiveData("/api/transactions?limit=100");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/api/transactions?limit=100");
  assert.equal(calls[0]?.init?.cache, "no-store");
});

test("fetchLiveData preserves caller init while forcing no-store caching", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<RequestInit | undefined> = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push(init);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await fetchLiveData("/api/budget-grid?monthFrom=2026-01&monthTo=2026-03&planFrom=2026-01&actualTo=2026-03", {
      headers: { Accept: "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cache, "no-store");
  assert.equal(new Headers(calls[0]?.headers).get("Accept"), "application/json");
});
