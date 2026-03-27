import assert from "node:assert/strict";
import test from "node:test";

import { ACCOUNTS_QUERY, TOTALS_QUERY, WARNINGS_QUERY } from "./getBalancesSummary";

test("balances queries use exact-day FX reads from fx_rates_daily", () => {
  assert.match(ACCOUNTS_QUERY, /^\s*WITH latest_rates AS \(/);
  assert.match(ACCOUNTS_QUERY, /FROM fx_rates_daily/);
  assert.match(ACCOUNTS_QUERY, /calendar_date = \$2/);

  assert.match(TOTALS_QUERY, /FROM fx_rates_daily/);
  assert.match(TOTALS_QUERY, /calendar_date = \$2/);

  assert.match(WARNINGS_QUERY, /FROM fx_rates_daily/);
  assert.doesNotMatch(ACCOUNTS_QUERY, /exchange_rates/);
  assert.doesNotMatch(TOTALS_QUERY, /exchange_rates/);
  assert.doesNotMatch(WARNINGS_QUERY, /exchange_rates/);
});
