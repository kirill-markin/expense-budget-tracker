import assert from "node:assert/strict";
import test from "node:test";
import { loadOpenApiDocument } from "./openapi.js";

test("loadOpenApiDocument returns the canonical v1 spec", () => {
  const document = loadOpenApiDocument();

  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.paths);
  assert.ok("/" in (document.paths as Record<string, unknown>));
  assert.ok("/sql" in (document.paths as Record<string, unknown>));
});

test("loadOpenApiDocument resolves the spec from the ESM module location", () => {
  const document = loadOpenApiDocument();

  assert.equal(typeof document.info, "object");
});

test("openapi documents restricted SQL ON CONFLICT and probe guidance", () => {
  const document = loadOpenApiDocument();
  const sqlPath = (document.paths as Record<string, { post?: { description?: string } }>)["/sql"];

  assert.match(String(sqlPath?.post?.description), /Restricted SQL does not support ON CONFLICT/i);
  assert.match(String(sqlPath?.post?.description), /tiny representative probe/i);
  assert.match(String(sqlPath?.post?.description), /at most 100 records per tool call/i);
  assert.match(String(sqlPath?.post?.description), /approval covers the full approved change set/i);
  assert.match(String(sqlPath?.post?.description), /including that probe and all remaining sequential batches/i);
  assert.match(String(sqlPath?.post?.description), /Do not pause only to ask the user to continue, proceed, or reconfirm for later batches/i);
  assert.match(String(sqlPath?.post?.description), /Only ask again if the requested change itself changes, new ambiguity appears, or execution fails/i);
});
