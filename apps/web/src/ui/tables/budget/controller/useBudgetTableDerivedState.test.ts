import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import type { BudgetAdjustmentEditorRow } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import { buildBlocks, type DirectionBlock } from "@/ui/tables/budget/budgetTableLogic";
import {
  getBudgetCategoryKey,
  hideEmptyBudgetCategories,
  selectVisibleBudgetCategoryKeys,
} from "@/ui/tables/budget/controller/useBudgetTableDerivedState";

const MONTHS: ReadonlyArray<string> = ["2026-07"];
const CURRENT_MONTH = "2026-07";

const budgetRow = (
  category: string,
  planned: number,
  actual: number,
  hasActualRows: boolean,
): BudgetRow => ({
  month: "2026-07",
  direction: "spend",
  category,
  plannedBase: planned,
  plannedModifier: 0,
  planned,
  actual,
  hasUnconvertible: false,
  hasActualRows,
});

const adjustmentRow = (
  category: string,
  amount: number,
): BudgetAdjustmentEditorRow => ({
  adjustmentId: `adjustment-${category}`,
  direction: "spend",
  draft: {
    amountInput: String(amount),
    noteInput: "",
    month: "2026-07",
    category,
  },
  confirmed: { amount, note: null, month: "2026-07", category },
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

const spendBlock = (rows: ReadonlyArray<BudgetRow>): DirectionBlock => {
  const block = buildBlocks(rows, MONTHS, CURRENT_MONTH, null)
    .find((candidate) => candidate.direction === "spend");
  if (block === undefined) {
    throw new Error("expected buildBlocks to produce a spend block");
  }
  return block;
};

const visibleSpendCategories = (
  rows: ReadonlyArray<BudgetRow>,
  adjustmentRows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  sessionEditedCategoryKeys: ReadonlySet<string>,
): ReadonlyArray<string> =>
  hideEmptyBudgetCategories(
    spendBlock(rows),
    selectVisibleBudgetCategoryKeys(rows, adjustmentRows, sessionEditedCategoryKeys),
  ).categories;

test("hides a category that carries no facts, no plan and no adjustment", (): void => {
  assert.deepEqual(
    visibleSpendCategories(
      [budgetRow("Funded", 100, 0, false), budgetRow("Empty", 0, 0, false)],
      [],
      new Set(),
    ),
    ["Funded"],
  );
});

test("keeps a category whose ledger facts net to zero", (): void => {
  assert.deepEqual(
    visibleSpendCategories([budgetRow("Refunded", 0, 0, true)], [], new Set()),
    ["Refunded"],
  );
});

test("keeps a category that still carries a zero-amount adjustment", (): void => {
  assert.deepEqual(
    visibleSpendCategories(
      [budgetRow("Noted", 0, 0, false)],
      [adjustmentRow("Noted", 0)],
      new Set(),
    ),
    ["Noted"],
  );
});

test("keeps a category the user edited in the current session", (): void => {
  assert.deepEqual(
    visibleSpendCategories(
      [budgetRow("Cleared", 0, 0, false)],
      [],
      new Set([getBudgetCategoryKey("spend", "Cleared")]),
    ),
    ["Cleared"],
  );
});

test("never hides the uncategorized category", (): void => {
  assert.deepEqual(
    [...visibleSpendCategories(
      [budgetRow("", 0, 0, false), budgetRow("Funded", 100, 0, false)],
      [],
      new Set(),
    )].sort(),
    ["", "Funded"],
  );
});

test("hiding leaves the unfiltered block, and the direction subtotals, untouched", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [
    budgetRow("Funded", 100, -40, true),
    budgetRow("Empty", 0, 0, false),
  ];
  const block = spendBlock(rows);
  const rendered = hideEmptyBudgetCategories(
    block,
    selectVisibleBudgetCategoryKeys(rows, [], new Set()),
  );

  assert.deepEqual([...block.categories].sort(), ["Empty", "Funded"]);
  assert.deepEqual(rendered.categories, ["Funded"]);
  assert.deepEqual(rendered.subtotals.get("2026-07"), {
    plannedBase: 100,
    plannedModifier: 0,
    planned: 100,
    actual: -40,
  });
});
