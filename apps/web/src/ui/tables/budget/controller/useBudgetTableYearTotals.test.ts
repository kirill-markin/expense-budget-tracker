import assert from "node:assert/strict";
import test from "node:test";

import type { YearFetchResult } from "@/ui/tables/budget/budgetTableLogic";
import {
  removeInvalidatedYearFetchResults,
  snapshotYearTotalInvalidation,
} from "@/ui/tables/budget/controller/useBudgetTableYearTotals";

const emptyYearResult = (): YearFetchResult => ({
  rows: [],
  cumulativeBefore: { incomeActual: 0, spendActual: 0, transferActual: 0 },
  monthEndBalances: {},
  monthEndBalancesByLiquidity: {},
  businessPersonalTransfers: {},
});

test("invalidates every affected year without dropping unaffected cached totals", (): void => {
  const cached = new Map<string, YearFetchResult>([
    ["2025", emptyYearResult()],
    ["2026", emptyYearResult()],
    ["2027", emptyYearResult()],
  ]);

  const invalidated = removeInvalidatedYearFetchResults(cached, new Set(["2026", "2027"]));

  assert.deepEqual([...invalidated.keys()], ["2025"]);
  assert.deepEqual([...cached.keys()], ["2025", "2026", "2027"]);
});

test("keeps invalidation stable after the caller mutates its set", (): void => {
  const cached = new Map<string, YearFetchResult>([
    ["2025", emptyYearResult()],
    ["2026", emptyYearResult()],
    ["2027", emptyYearResult()],
  ]);
  const callerOwnedYears = new Set(["2026", "2027"]);
  const invalidatedYears = snapshotYearTotalInvalidation(callerOwnedYears);

  callerOwnedYears.clear();
  const invalidated = removeInvalidatedYearFetchResults(cached, invalidatedYears);

  assert.deepEqual([...invalidated.keys()], ["2025"]);
});
