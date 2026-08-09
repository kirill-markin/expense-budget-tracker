import assert from "node:assert/strict";
import test from "node:test";

import type { YearFetchResult } from "@/ui/tables/budget/budgetTableLogic";
import {
  buildYearTotalRequest,
  getObservedYearsToFetch,
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

test("deduplicates fetched and current-revision annual requests", (): void => {
  const years = getObservedYearsToFetch(
    new Set(["2025", "2026", "2027"]),
    new Set(["2025"]),
    new Map([["2026", 0]]),
    new Map([["2026", 0], ["2027", 2]]),
  );

  assert.deepEqual(years, [{ year: "2027", revision: 2 }]);
});

test("builds an exact January-through-December annual request", (): void => {
  assert.deepEqual(buildYearTotalRequest("2031", "2026-08"), {
    monthFrom: "2031-01",
    monthTo: "2031-12",
    planFrom: "2031-01",
    actualTo: "2026-08",
  });
});
