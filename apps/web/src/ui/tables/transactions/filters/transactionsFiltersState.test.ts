import assert from "node:assert/strict";
import test from "node:test";

import { serializeFilterValues } from "./transactionsFiltersState";

test("serializeFilterValues distinguishes empty array from nullable sentinel", (): void => {
  assert.notEqual(serializeFilterValues([]), serializeFilterValues([""]));
});

test("serializeFilterValues distinguishes nullable sentinel from mixed values", (): void => {
  assert.notEqual(serializeFilterValues([""]), serializeFilterValues(["", "x"]));
});

test("serializeFilterValues is stable for the same ordered values", (): void => {
  assert.equal(
    serializeFilterValues(["a", "", "b"]),
    serializeFilterValues(["a", "", "b"]),
  );
});
