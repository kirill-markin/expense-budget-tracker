import assert from "node:assert/strict";
import test from "node:test";

import { QUERY } from "./getFxBreakdown";

test("fx breakdown SQL reads month-end rates from fx_rates_daily", () => {
  assert.match(QUERY, /LEFT JOIN fx_rates_daily rr/);
  assert.match(QUERY, /rr\.calendar_date = \(date_trunc\('month', to_date\(rb\.month, 'YYYY-MM'\)\) \+ interval '1 month' - interval '1 day'\)::date/);
  assert.doesNotMatch(QUERY, /exchange_rates/);
});
