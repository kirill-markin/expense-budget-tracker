import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import type { BudgetAdjustmentEditorRow } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import {
  buildBlocks,
  computeAllowedSubtotals,
  computeCumulativeBalances,
  computeCumulativeBalancesByLiquidity,
  computeFxAdjustments,
  lookupCell,
  zeroCellValue,
  type DirectionBlock,
} from "@/ui/tables/budget/budgetTableLogic";
import {
  getBudgetCategoryKey,
  hideEmptyBudgetCategories,
  selectVisibleBudgetCategoryKeys,
  withNamedCategoryDirectionBlocks,
  withSessionAddedBudgetCategories,
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

/** Mirrors the hook: income and spend always have a block, with or without rows. */
const directionBlock = (rows: ReadonlyArray<BudgetRow>, direction: string): DirectionBlock => {
  const block = withNamedCategoryDirectionBlocks(
    buildBlocks(rows, MONTHS, CURRENT_MONTH, null),
    MONTHS,
    null,
  ).find((candidate) => candidate.direction === direction);
  if (block === undefined) {
    throw new Error(`expected a ${direction} block`);
  }
  return block;
};

const spendBlock = (rows: ReadonlyArray<BudgetRow>): DirectionBlock => directionBlock(rows, "spend");

const visibleSpendCategories = (
  rows: ReadonlyArray<BudgetRow>,
  adjustmentRows: ReadonlyArray<BudgetAdjustmentEditorRow>,
  sessionEditedCategoryKeys: ReadonlySet<string>,
): ReadonlyArray<string> =>
  hideEmptyBudgetCategories(
    spendBlock(rows),
    selectVisibleBudgetCategoryKeys(rows, adjustmentRows, sessionEditedCategoryKeys),
  ).categories;

/**
 * Mirrors the hook: session-added names join the unfiltered block first, and
 * adding one also marks it edited in the session, so the hiding rule keeps it.
 */
const renderedSpendBlock = (
  rows: ReadonlyArray<BudgetRow>,
  sessionAddedCategories: ReadonlyArray<string>,
): DirectionBlock => {
  const withAdded = withSessionAddedBudgetCategories(spendBlock(rows), sessionAddedCategories);
  const sessionEditedCategoryKeys = new Set(
    sessionAddedCategories.map((category) => getBudgetCategoryKey("spend", category)),
  );
  return hideEmptyBudgetCategories(
    withAdded,
    selectVisibleBudgetCategoryKeys(rows, [], sessionEditedCategoryKeys),
  );
};

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

test("renders a category named in this session as an all-zero trailing row", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [budgetRow("Funded", 100, -40, true)];
  const rendered = renderedSpendBlock(rows, ["Coffee"]);

  assert.deepEqual(rendered.categories, ["Funded", "Coffee"]);
  assert.deepEqual(lookupCell(rendered.cells, "2026-07", "Coffee"), {
    plannedBase: 0,
    plannedModifier: 0,
    planned: 0,
    actual: 0,
  });
  assert.deepEqual(rendered.subtotals.get("2026-07"), {
    plannedBase: 100,
    plannedModifier: 0,
    planned: 100,
    actual: -40,
  });
});

test("a category named in this session is gone after a reload, because it has no row", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [budgetRow("Funded", 100, -40, true)];

  assert.deepEqual(renderedSpendBlock(rows, ["Coffee"]).categories, ["Funded", "Coffee"]);
  assert.deepEqual(renderedSpendBlock(rows, []).categories, ["Funded"]);
});

test("naming a category that already exists adds no second row", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [budgetRow("Funded", 100, -40, true)];

  assert.deepEqual(renderedSpendBlock(rows, ["Funded"]).categories, ["Funded"]);
});

test("naming a currently hidden category shows that category instead of a new row", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [
    budgetRow("Funded", 100, 0, false),
    budgetRow("Empty", 0, 0, false),
  ];

  assert.deepEqual(renderedSpendBlock(rows, []).categories, ["Funded"]);
  assert.deepEqual(renderedSpendBlock(rows, ["Empty"]).categories, ["Funded", "Empty"]);
});

test("session-added names reach the unfiltered category list the pickers read", (): void => {
  const block = withSessionAddedBudgetCategories(
    spendBlock([budgetRow("Funded", 100, -40, true)]),
    ["Coffee"],
  );

  assert.deepEqual(block.categories, ["Funded", "Coffee"]);
});

test("a workspace with no rows at all still has an income and a spend block", (): void => {
  const blocks = withNamedCategoryDirectionBlocks(
    buildBlocks([], MONTHS, CURRENT_MONTH, null),
    MONTHS,
    null,
  );

  assert.deepEqual(blocks.map((block) => block.direction), ["income", "spend"]);
  assert.deepEqual(blocks.map((block) => block.categories), [[], []]);
  for (const block of blocks) {
    assert.deepEqual(block.subtotals.get("2026-07"), zeroCellValue);
  }
});

test("a direction that lost its last category keeps its block, so a name can be added again", (): void => {
  const incomeRow: BudgetRow = { ...budgetRow("Salary", 100, 100, true), direction: "income" };
  const blocks = withNamedCategoryDirectionBlocks(
    buildBlocks([incomeRow], MONTHS, CURRENT_MONTH, null),
    MONTHS,
    null,
  );

  assert.deepEqual(blocks.map((block) => block.direction), ["income", "spend"]);
  assert.deepEqual(directionBlock([incomeRow], "income").categories, ["Salary"]);
  assert.deepEqual(renderedSpendBlock([incomeRow], ["Coffee"]).categories, ["Coffee"]);
});

test("a synthesized block lands in DIRECTION_ORDER, not after the blocks that exist", (): void => {
  const transferRow: BudgetRow = { ...budgetRow("Savings", 100, 100, true), direction: "transfer" };
  const blocks = withNamedCategoryDirectionBlocks(
    buildBlocks([transferRow], MONTHS, CURRENT_MONTH, null),
    MONTHS,
    null,
  );

  assert.deepEqual(blocks.map((block) => block.direction), ["income", "spend", "transfer"]);
  assert.deepEqual(
    blocks.find((block) => block.direction === "transfer")?.categories,
    ["Savings"],
  );
});

test("filtered mode synthesizes nothing, because it offers no add-category control", (): void => {
  const incomeRow: BudgetRow = { ...budgetRow("Salary", 100, 100, true), direction: "income" };
  const allowlist: ReadonlySet<string> = new Set(["Salary"]);

  assert.deepEqual(
    withNamedCategoryDirectionBlocks(
      buildBlocks([incomeRow], MONTHS, CURRENT_MONTH, allowlist),
      MONTHS,
      allowlist,
    ).map((block) => block.direction),
    ["income"],
  );
  assert.deepEqual(
    withNamedCategoryDirectionBlocks(
      buildBlocks([], MONTHS, CURRENT_MONTH, allowlist),
      MONTHS,
      allowlist,
    ),
    [],
  );
});

test("a category named in an empty workspace renders as its only row", (): void => {
  assert.deepEqual(renderedSpendBlock([], ["Coffee"]).categories, ["Coffee"]);
  assert.deepEqual(renderedSpendBlock([], []).categories, []);
});

test("synthesized zero subtotals are indistinguishable from a missing direction", (): void => {
  const incomeSubtotals = directionBlock([], "income").subtotals;
  const spendSubtotals = directionBlock([], "spend").subtotals;
  const cumBefore = { incomeActual: 120, spendActual: 50, transferActual: 10 };
  const monthEndBalances: Readonly<Record<string, number>> = { "2026-06": 500, "2026-07": 530 };
  const monthEndByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    "2026-06": { high: 400, medium: 100 },
  };
  const noTaintedMonths: ReadonlySet<string> = new Set<string>();

  assert.deepEqual(
    computeCumulativeBalances(
      MONTHS, incomeSubtotals, spendSubtotals, undefined,
      cumBefore, noTaintedMonths, CURRENT_MONTH, monthEndBalances,
    ),
    computeCumulativeBalances(
      MONTHS, undefined, undefined, undefined,
      cumBefore, noTaintedMonths, CURRENT_MONTH, monthEndBalances,
    ),
  );
  assert.deepEqual(
    computeFxAdjustments(MONTHS, incomeSubtotals, spendSubtotals, undefined, monthEndBalances, CURRENT_MONTH),
    computeFxAdjustments(MONTHS, undefined, undefined, undefined, monthEndBalances, CURRENT_MONTH),
  );
  assert.deepEqual(
    computeCumulativeBalancesByLiquidity(
      MONTHS, incomeSubtotals, spendSubtotals, undefined, CURRENT_MONTH, monthEndByLiquidity,
    ),
    computeCumulativeBalancesByLiquidity(
      MONTHS, undefined, undefined, undefined, CURRENT_MONTH, monthEndByLiquidity,
    ),
  );
});

test("a synthesized direction adds only zeros to the filtered subtotals", (): void => {
  assert.deepEqual(
    computeAllowedSubtotals(directionBlock([], "spend"), MONTHS, new Set(["Coffee"])).get("2026-07"),
    zeroCellValue,
  );
});
