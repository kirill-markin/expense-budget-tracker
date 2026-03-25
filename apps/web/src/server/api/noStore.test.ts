import assert from "node:assert/strict";
import test from "node:test";

import { applyNoStoreHeaders, jsonNoStore } from "./noStore";

test("applyNoStoreHeaders appends the live-data no-store policy", () => {
  const headers = applyNoStoreHeaders({ "Content-Type": "application/json" });

  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  assert.equal(headers.get("Pragma"), "no-cache");
  assert.equal(headers.get("Expires"), "0");
});

test("jsonNoStore returns JSON responses with no-store headers", async () => {
  const response = jsonNoStore({ ok: true });

  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Expires"), "0");
  assert.deepEqual(await response.json(), { ok: true });
});
