import assert from "node:assert/strict";
import test from "node:test";

import { QUERY } from "./getFxBreakdown";

test("fx breakdown SQL reads month-end rates from fx_rates_daily", () => {
  assert.match(QUERY, /LEFT JOIN fx_rates_daily rr/);
  assert.match(QUERY, /LEAST\(/);
  assert.match(QUERY, /to_date\(\$3, 'YYYY-MM-DD'\)/);
  assert.match(QUERY, /rr\.calendar_date = vd\.valuation_date/);
  assert.match(QUERY, /LEFT JOIN fx_rates_daily r/);
  assert.match(QUERY, /r\.calendar_date = le\.ts::date/);
  assert.match(QUERY, /COALESCE\(c\.flow_report, 0\)/);
  assert.doesNotMatch(QUERY, /exchange_rates/);
});

test("fx breakdown SQL derives FX adjust as close minus open minus flow", () => {
  assert.match(QUERY, /AS fx_adjust_report/);
  assert.match(QUERY, /COALESCE\(c\.flow_report, 0\)\s*\)\:\:numeric, 2\) AS fx_adjust_report/);
});
