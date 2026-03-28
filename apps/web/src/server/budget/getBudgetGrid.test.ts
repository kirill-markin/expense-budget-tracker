import assert from "node:assert/strict";
import test from "node:test";

import { CUMULATIVE_BALANCE_QUERY, MONTH_END_BALANCES_QUERY, QUERY } from "./getBudgetGrid";

test("budget grid SQL keeps spend actuals directional instead of taking abs()", () => {
  assert.match(QUERY, /WHEN le\.kind = 'spend' THEN -\(/);
  assert.doesNotMatch(QUERY, /ABS\(/);
});

test("budget cumulative SQL keeps spend totals directional instead of taking abs()", () => {
  assert.match(CUMULATIVE_BALANCE_QUERY, /WHEN le\.kind = 'spend' THEN -\(/);
  assert.doesNotMatch(CUMULATIVE_BALANCE_QUERY, /ABS\(/);
});

test("budget queries read exact-date FX pairs from fx_rates_daily", () => {
  assert.match(QUERY, /LEFT JOIN fx_rates_daily r/);
  assert.match(QUERY, /r\.calendar_date = le\.ts::date/);
  assert.match(CUMULATIVE_BALANCE_QUERY, /LEFT JOIN fx_rates_daily r/);
  assert.match(CUMULATIVE_BALANCE_QUERY, /r\.calendar_date = le\.ts::date/);
  assert.doesNotMatch(QUERY, /exchange_rates/);
  assert.doesNotMatch(CUMULATIVE_BALANCE_QUERY, /exchange_rates/);
});

test("month-end balances cap open months to the latest available FX day", () => {
  assert.match(MONTH_END_BALANCES_QUERY, /LEAST\(/);
  assert.match(MONTH_END_BALANCES_QUERY, /to_date\(\$4, 'YYYY-MM-DD'\)/);
  assert.match(MONTH_END_BALANCES_QUERY, /rr\.calendar_date = vd\.valuation_date/);
});
