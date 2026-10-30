import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRangeExtension } from "@/ui/tables/budget/budgetTableLogic";
import { getTargetFillMonths } from "@/ui/tables/budget/budgetTableLogic";
import type { BudgetBaseCell } from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import {
  buildBudgetViewportRetryKey,
  getAcknowledgedBaseYears,
  retainPendingBudgetViewportRetryProgress,
  selectBudgetViewportRangeExtension,
} from "@/ui/tables/budget/controller/useBudgetTableRangeState";

const exhaustedProgress = {
  completedAttemptCount: 0,
  completedCycleCount: 2,
  status: "exhausted" as const,
};

test("selects another pending viewport side after one exact key exhausts", (): void => {
  const left: BudgetRangeExtension = {
    direction: "left",
    monthFrom: "2025-01",
    monthTo: "2025-06",
  };
  const right: BudgetRangeExtension = {
    direction: "right",
    monthFrom: "2026-07",
    monthTo: "2026-12",
  };
  const progressByKey = new Map([
    [
      buildBudgetViewportRetryKey(
        left.direction,
        left.monthFrom,
        left.monthTo,
      ),
      exhaustedProgress,
    ],
  ]);

  assert.deepEqual(
    selectBudgetViewportRangeExtension([left, right], progressByKey),
    right,
  );
  progressByKey.set(
    buildBudgetViewportRetryKey(
      right.direction,
      right.monthFrom,
      right.monthTo,
    ),
    exhaustedProgress,
  );
  assert.equal(
    selectBudgetViewportRangeExtension([left, right], progressByKey),
    null,
  );
});

test("gives a genuinely expanded viewport extension a fresh budget", (): void => {
  const exhaustedLeft: BudgetRangeExtension = {
    direction: "left",
    monthFrom: "2025-01",
    monthTo: "2025-06",
  };
  const expandedLeft: BudgetRangeExtension = {
    direction: "left",
    monthFrom: "2024-07",
    monthTo: "2025-06",
  };
  const progressByKey = new Map([
    [
      buildBudgetViewportRetryKey(
        exhaustedLeft.direction,
        exhaustedLeft.monthFrom,
        exhaustedLeft.monthTo,
      ),
      exhaustedProgress,
    ],
  ]);

  assert.deepEqual(
    selectBudgetViewportRangeExtension([expandedLeft], progressByKey),
    expandedLeft,
  );
});

test("retains only retry progress for exact keys that remain pending", (): void => {
  const pendingKey = buildBudgetViewportRetryKey(
    "right",
    "2026-07",
    "2026-12",
  );
  const obsoleteKey = buildBudgetViewportRetryKey(
    "left",
    "2025-01",
    "2025-06",
  );
  const progressByKey = new Map([
    [pendingKey, exhaustedProgress],
    [obsoleteKey, exhaustedProgress],
  ]);

  const retained = retainPendingBudgetViewportRetryProgress(
    progressByKey,
    new Set([pendingKey]),
  );

  assert.deepEqual([...retained.keys()], [pendingKey]);
  assert.deepEqual([...progressByKey.keys()], [pendingKey, obsoleteKey]);
});

test("invalidates the single year a base plan acknowledgement changed", (): void => {
  assert.deepEqual(
    [...getAcknowledgedBaseYears([
      { month: "2026-07", direction: "spend", category: "Food" },
    ])],
    ["2026"],
  );
});

test("invalidates one year for a fill-months acknowledgement", (): void => {
  const cells = getTargetFillMonths("2026-07").map((month): BudgetBaseCell => ({
    month,
    direction: "spend",
    category: "Food",
  }));

  assert.deepEqual(cells.at(-1)?.month, "2026-12");
  assert.deepEqual([...getAcknowledgedBaseYears(cells)], ["2026"]);
});
