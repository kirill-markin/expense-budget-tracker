import assert from "node:assert/strict";
import test from "node:test";

import type { AccountRow } from "@/server/balances/getBalancesSummary";
import { calculateReportingCurrencyTotals } from "@/ui/tables/balances/balancesTableModel";

const account = (
  accountId: string,
  balance: number,
  balanceReport: number | null,
): AccountRow => ({
  accountId,
  currency: "EUR",
  liquidity: "high",
  accountType: "personal",
  accountGroup: "regular",
  status: "active",
  balance,
  balanceReport,
  lastTransactionTs: null,
  overdue: false,
});

test("calculateReportingCurrencyTotals preserves gross account balances with mixed signs in one currency", (): void => {
  const totals = calculateReportingCurrencyTotals([
    account("positive", 100, 110),
    account("negative", -40, -44),
  ]);

  assert.deepEqual(totals, {
    balance: 66,
    balancePositive: 110,
    balanceNegative: -44,
  });
  assert.equal(totals.balancePositive! + totals.balanceNegative!, totals.balance);
});

test("calculateReportingCurrencyTotals makes affected totals unavailable when a non-zero balance lacks conversion", (): void => {
  assert.deepEqual(
    calculateReportingCurrencyTotals([
      account("missing-positive", 100, null),
      account("converted-negative", -40, -44),
    ]),
    {
      balance: null,
      balancePositive: null,
      balanceNegative: -44,
    },
  );

  assert.deepEqual(
    calculateReportingCurrencyTotals([
      account("converted-positive", 100, 110),
      account("missing-negative", -40, null),
    ]),
    {
      balance: null,
      balancePositive: 110,
      balanceNegative: null,
    },
  );
});

test("calculateReportingCurrencyTotals ignores missing conversion for a zero balance", (): void => {
  assert.deepEqual(
    calculateReportingCurrencyTotals([
      account("zero", 0, null),
      account("converted", 100, 110),
    ]),
    {
      balance: 110,
      balancePositive: 110,
      balanceNegative: 0,
    },
  );
});
