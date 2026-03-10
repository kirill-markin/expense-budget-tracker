import assert from "node:assert/strict";
import test from "node:test";
import { loadOpenApiDocument } from "./openapi";

test("loadOpenApiDocument returns the canonical v1 spec", () => {
  const document = loadOpenApiDocument();

  assert.equal(document.openapi, "3.1.0");
  assert.ok(document.paths);
  assert.ok("/" in (document.paths as Record<string, unknown>));
  assert.ok("/sql" in (document.paths as Record<string, unknown>));
});
