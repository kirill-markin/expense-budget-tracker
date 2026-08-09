import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { computeYearTotal } from "@/ui/tables/budget/model/yearTotals";

const budgetRow = (
  month: string,
  direction: string,
  category: string,
  planned: number,
  actual: number,
): BudgetRow => ({
  month,
  direction,
  category,
  plannedBase: planned,
  plannedModifier: 0,
  planned,
  actual,
  hasUnconvertible: false,
});

test("computeYearTotal uses actuals from completed months in the current-year plan", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [
    budgetRow("2026-01", "income", "Included", 100, 10),
    budgetRow("2026-05", "income", "Included", 50, 5),
    budgetRow("2026-12", "income", "Included", 30, 99),
    budgetRow("2026-01", "income", "Excluded", 200, 20),
    budgetRow("2026-05", "income", "Excluded", 40, 4),
    budgetRow("2026-12", "income", "Excluded", 10, 1),
    budgetRow("2026-01", "spend", "Cost", 100, 5),
    budgetRow("2026-05", "spend", "Cost", 20, 2),
    budgetRow("2026-12", "spend", "Cost", 15, 3),
    budgetRow("2026-01", "transfer", "Move", 9, 2),
    budgetRow("2026-05", "transfer", "Move", 5, 1),
    budgetRow("2026-12", "transfer", "Move", 3, 4),
  ];

  const total = computeYearTotal(
    rows,
    { incomeActual: 0, spendActual: 0, transferActual: 0 },
    {},
    {},
    {},
    "2026",
    "2026-05",
    new Set(["Included"]),
  );

  assert.deepEqual(total.directionCategoryTotals.get("income")?.get("Included"), {
    plannedBase: 180,
    plannedModifier: 0,
    planned: 90,
    actual: 114,
  });
  assert.deepEqual(total.directionCategoryTotals.get("income")?.get("Excluded"), {
    plannedBase: 250,
    plannedModifier: 0,
    planned: 70,
    actual: 25,
  });
  assert.equal(total.directionSubtotals.get("income")?.planned, 160);
  assert.equal(total.directionSubtotals.get("income")?.actual, 139);
  assert.equal(total.filteredSubtotals.get("income")?.planned, 90);
  assert.equal(total.filteredSubtotals.get("income")?.actual, 114);
  assert.equal(total.remainder.planned, 130);
  assert.equal(total.remainder.actual, 136);
});

test("computeYearTotal keeps full-year plans for past and future years", (): void => {
  for (const year of ["2025", "2027"]) {
    const rows: ReadonlyArray<BudgetRow> = [
      budgetRow(`${year}-01`, "income", "Salary", 100, 10),
      budgetRow(`${year}-05`, "income", "Salary", 50, 5),
      budgetRow(`${year}-12`, "income", "Salary", 30, 99),
    ];

    const total = computeYearTotal(
      rows,
      { incomeActual: 0, spendActual: 0, transferActual: 0 },
      {},
      {},
      {},
      year,
      "2026-05",
      null,
    );

    assert.equal(total.directionCategoryTotals.get("income")?.get("Salary")?.planned, 180);
    assert.equal(total.directionCategoryTotals.get("income")?.get("Salary")?.actual, 114);
  }
});
