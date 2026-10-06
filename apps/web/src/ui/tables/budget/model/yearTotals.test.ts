import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import type { BudgetPlansMode } from "@/ui/tables/budget/model/plansMode";
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
  unconvertibleCurrencies: [],
  hasActualRows: false,
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
    "actuals",
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
      "actuals",
    );

    assert.equal(total.directionCategoryTotals.get("income")?.get("Salary")?.planned, 180);
    assert.equal(total.directionCategoryTotals.get("income")?.get("Salary")?.actual, 114);
  }
});

test("computeYearTotal sums pure plans for the current year in the all-plans mode", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [
    budgetRow("2026-01", "income", "Salary", 100, 10),
    budgetRow("2026-05", "income", "Salary", 50, 5),
    budgetRow("2026-12", "income", "Salary", 30, 99),
    budgetRow("2026-01", "spend", "Cost", 100, 5),
  ];

  const total = computeYearTotal(
    rows,
    { incomeActual: 0, spendActual: 0, transferActual: 0 },
    {},
    {},
    {},
    "2026",
    "2026-05",
    null,
    "all-plans",
  );

  assert.deepEqual(total.directionCategoryTotals.get("income")?.get("Salary"), {
    plannedBase: 180,
    plannedModifier: 0,
    planned: 180,
    actual: 114,
  });
  assert.equal(total.directionSubtotals.get("income")?.planned, 180);
  assert.equal(total.directionSubtotals.get("spend")?.planned, 100);
  assert.equal(total.remainder.planned, 80);
  assert.equal(total.remainder.actual, 109);
});

test("computeYearTotal keeps the elapsed-month substitution out of past years in both modes", (): void => {
  const rows: ReadonlyArray<BudgetRow> = [
    budgetRow("2025-03", "income", "Salary", 70, 7),
    budgetRow("2025-11", "income", "Salary", 40, 4),
  ];
  const yearTotalForMode = (plansMode: BudgetPlansMode): number | undefined =>
    computeYearTotal(
      rows,
      { incomeActual: 0, spendActual: 0, transferActual: 0 },
      {},
      {},
      {},
      "2025",
      "2026-05",
      null,
      plansMode,
    ).directionSubtotals.get("income")?.planned;

  assert.equal(yearTotalForMode("actuals"), 110);
  assert.equal(yearTotalForMode("all-plans"), 110);
});

test("computeYearTotal embeds actuals in the plan only for the current year in the actuals mode", (): void => {
  const planEmbedsActualsFor = (year: string, plansMode: BudgetPlansMode): boolean =>
    computeYearTotal(
      [],
      { incomeActual: 0, spendActual: 0, transferActual: 0 },
      {},
      {},
      {},
      year,
      "2026-05",
      null,
      plansMode,
    ).planEmbedsActuals;

  assert.equal(planEmbedsActualsFor("2026", "actuals"), true);
  assert.equal(planEmbedsActualsFor("2025", "actuals"), false);
  assert.equal(planEmbedsActualsFor("2027", "actuals"), false);
  assert.equal(planEmbedsActualsFor("2026", "all-plans"), false);
  assert.equal(planEmbedsActualsFor("2025", "all-plans"), false);
  assert.equal(planEmbedsActualsFor("2027", "all-plans"), false);
});

test("computeYearTotal unions unconvertible currencies per direction, per category and per year", (): void => {
  const unconvertibleRow = (
    month: string,
    direction: string,
    category: string,
    currencies: ReadonlyArray<string>,
  ): BudgetRow => ({
    ...budgetRow(month, direction, category, 0, 0),
    hasUnconvertible: true,
    unconvertibleCurrencies: currencies,
  });

  const rows: ReadonlyArray<BudgetRow> = [
    unconvertibleRow("2026-01", "spend", "Groceries", ["USD", "RSD"]),
    unconvertibleRow("2026-03", "spend", "Groceries", ["EUR", "USD"]),
    unconvertibleRow("2026-03", "spend", "Rent", ["GBP"]),
    unconvertibleRow("2026-07", "income", "Salary", ["RSD"]),
    budgetRow("2026-02", "spend", "Groceries", 10, 10),
    budgetRow("2026-02", "transfer", "Move", 5, 5),
  ];

  const total = computeYearTotal(
    rows,
    { incomeActual: 0, spendActual: 0, transferActual: 0 },
    {},
    {},
    {},
    "2026",
    "2026-05",
    null,
    "actuals",
  );

  assert.deepEqual(total.unconvertibleCurrenciesByDirection, new Map([
    ["spend", ["EUR", "GBP", "RSD", "USD"]],
    ["income", ["RSD"]],
  ]));
  assert.deepEqual(total.unconvertibleCurrenciesByCategory, new Map([
    ["spend::Groceries", ["EUR", "RSD", "USD"]],
    ["spend::Rent", ["GBP"]],
    ["income::Salary", ["RSD"]],
  ]));
  assert.deepEqual(total.unconvertibleCurrencies, ["EUR", "GBP", "RSD", "USD"]);
});
