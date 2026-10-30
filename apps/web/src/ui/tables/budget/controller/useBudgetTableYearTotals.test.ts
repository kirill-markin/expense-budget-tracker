import assert from "node:assert/strict";
import test from "node:test";

import type { YearFetchResult } from "@/ui/tables/budget/budgetTableLogic";
import {
  addYearTotalStaleMarks,
  buildYearTotalRequest,
  createYearTotalInvalidationScheduler,
  getObservedYearsToFetch,
  removeInvalidatedYearFetchResults,
  removeYearTotalStaleMarks,
  snapshotYearTotalInvalidation,
  YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS,
} from "@/ui/tables/budget/controller/useBudgetTableYearTotals";

type SchedulerClock = Readonly<{
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timeoutId: number) => void;
  runPending: () => void;
  pendingCount: () => number;
  delays: ReadonlyArray<number>;
}>;

const createSchedulerClock = (): SchedulerClock => {
  const pending = new Map<number, () => void>();
  const delays: Array<number> = [];
  let nextTimeoutId = 1;
  return {
    setTimer: (callback, delayMs): number => {
      const timeoutId = nextTimeoutId;
      nextTimeoutId += 1;
      delays.push(delayMs);
      pending.set(timeoutId, callback);
      return timeoutId;
    },
    clearTimer: (timeoutId): void => {
      pending.delete(timeoutId);
    },
    runPending: (): void => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    pendingCount: (): number => pending.size,
    delays,
  };
};

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
    new Set(),
    new Map([["2026", 0]]),
    new Map([["2026", 0], ["2027", 2]]),
  );

  assert.deepEqual(years, [{ year: "2027", revision: 2 }]);
});

test("refetches a cached year total while its stale mark stands", (): void => {
  const staleYears = addYearTotalStaleMarks(new Set(), new Set(["2026"]));

  assert.deepEqual(
    getObservedYearsToFetch(
      new Set(["2025", "2026"]),
      new Set(["2025", "2026"]),
      staleYears,
      new Map(),
      new Map([["2026", 1]]),
    ),
    [{ year: "2026", revision: 1 }],
  );
});

test("replans the refetch of a year marked stale again at a newer revision", (): void => {
  const firstMark = addYearTotalStaleMarks(new Set(), new Set(["2026"]));
  const secondMark = addYearTotalStaleMarks(firstMark, new Set(["2026"]));

  assert.notEqual(secondMark, firstMark);
  assert.deepEqual([...secondMark], ["2026"]);
});

test("stops refetching a year once a landed fresh result clears its mark", (): void => {
  const staleYears = removeYearTotalStaleMarks(
    addYearTotalStaleMarks(new Set(), new Set(["2026"])),
    new Set(["2026"]),
  );

  assert.deepEqual([...staleYears], []);
  assert.deepEqual(
    getObservedYearsToFetch(
      new Set(["2026"]),
      new Set(["2026"]),
      staleYears,
      new Map(),
      new Map([["2026", 1]]),
    ),
    [],
  );
});

test("drops the retained stale total when a year exhausts its retries", (): void => {
  const cached = new Map<string, YearFetchResult>([
    ["2026", emptyYearResult()],
    ["2027", emptyYearResult()],
  ]);
  const staleYears = addYearTotalStaleMarks(new Set(), new Set(["2026"]));
  // The column read the retained total for as long as the refetch could still
  // land; exhaustion takes both the mark and the number away.
  assert.equal(cached.has("2026"), true);

  assert.deepEqual(
    [...removeInvalidatedYearFetchResults(cached, new Set(["2026"])).keys()],
    ["2027"],
  );
  assert.deepEqual([...removeYearTotalStaleMarks(staleYears, new Set(["2026"]))], []);
});

test("coalesces a burst of invalidations for one year into a single refetch", (): void => {
  const clock = createSchedulerClock();
  const invalidatedYears: Array<ReadonlyArray<string>> = [];
  const scheduler = createYearTotalInvalidationScheduler({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    invalidateYears: (years): void => {
      invalidatedYears.push([...years].sort());
    },
  });

  scheduler.schedule(new Set(["2026"]));
  scheduler.schedule(new Set(["2026"]));
  scheduler.schedule(new Set(["2026"]));
  assert.equal(clock.pendingCount(), 1);
  assert.deepEqual(invalidatedYears, []);
  assert.deepEqual(clock.delays, [
    YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS,
    YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS,
    YEAR_TOTAL_INVALIDATION_COALESCE_DELAY_MS,
  ]);

  clock.runPending();
  assert.deepEqual(invalidatedYears, [["2026"]]);
  assert.equal(clock.pendingCount(), 0);
});

test("coalesces every invalidated year on its own timer", (): void => {
  const clock = createSchedulerClock();
  const invalidatedYears: Array<ReadonlyArray<string>> = [];
  const scheduler = createYearTotalInvalidationScheduler({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    invalidateYears: (years): void => {
      invalidatedYears.push([...years].sort());
    },
  });

  scheduler.schedule(new Set(["2026", "2027"]));
  scheduler.schedule(new Set(["2026"]));
  assert.equal(clock.pendingCount(), 2);

  clock.runPending();
  assert.equal(invalidatedYears.length, 2);
  assert.deepEqual(invalidatedYears.flat().sort(), ["2026", "2027"]);
});

test("cancels pending coalesced invalidations on reset and unmount", (): void => {
  const clock = createSchedulerClock();
  const invalidatedYears: Array<ReadonlyArray<string>> = [];
  const scheduler = createYearTotalInvalidationScheduler({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    invalidateYears: (years): void => {
      invalidatedYears.push([...years].sort());
    },
  });

  scheduler.schedule(new Set(["2026", "2027"]));
  scheduler.cancelAll();

  assert.equal(clock.pendingCount(), 0);
  clock.runPending();
  assert.deepEqual(invalidatedYears, []);
});

test("builds an exact January-through-December annual request", (): void => {
  assert.deepEqual(buildYearTotalRequest("2031", "2026-08"), {
    monthFrom: "2031-01",
    monthTo: "2031-12",
    planFrom: "2031-01",
    actualTo: "2026-08",
  });
});
