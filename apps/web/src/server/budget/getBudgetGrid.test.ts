import assert from "node:assert/strict";
import test from "node:test";

import { CUMULATIVE_BALANCE_QUERY, QUERY } from "./getBudgetGrid";

test("budget grid SQL keeps spend actuals directional instead of taking abs()", () => {
  assert.match(QUERY, /WHEN le\.kind = 'spend' THEN -\(/);
  assert.doesNotMatch(QUERY, /ABS\(/);
});

test("budget cumulative SQL keeps spend totals directional instead of taking abs()", () => {
  assert.match(CUMULATIVE_BALANCE_QUERY, /WHEN le\.kind = 'spend' THEN -\(/);
  assert.doesNotMatch(CUMULATIVE_BALANCE_QUERY, /ABS\(/);
});
