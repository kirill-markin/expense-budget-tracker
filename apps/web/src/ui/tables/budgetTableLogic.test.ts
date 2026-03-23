import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import {
  adjustCumulativeBeforeForPrependedRows,
  buildBudgetTaintedState,
} from "./budgetTableLogic";

const createBudgetRow = (overrides: Partial<BudgetRow>): BudgetRow => ({
  month: "2026-03",
  direction: "income",
  category: "Salary",
  plannedBase: 0,
  plannedModifier: 0,
  planned: 0,
  actual: 0,
  hasUnconvertible: false,
  ...overrides,
});

test("buildBudgetTaintedState derives all tainted key sets from unconvertible rows", () => {
  const state = buildBudgetTaintedState([
    createBudgetRow({
      month: "2026-01",
      direction: "income",
      category: "Salary",
      hasUnconvertible: true,
    }),
    createBudgetRow({
      month: "2026-01",
      direction: "income",
      category: "Bonus",
      hasUnconvertible: true,
    }),
    createBudgetRow({
      month: "2026-02",
      direction: "spend",
      category: "Rent",
      hasUnconvertible: true,
    }),
    createBudgetRow({
      month: "2026-02",
      direction: "transfer",
      category: "Savings",
      hasUnconvertible: false,
    }),
  ]);

  assert.deepEqual([...state.taintedCells].sort(), [
    "income::2026-01::Bonus",
    "income::2026-01::Salary",
    "spend::2026-02::Rent",
  ]);
  assert.deepEqual([...state.taintedDirectionMonths].sort(), [
    "income::2026-01",
    "spend::2026-02",
  ]);
  assert.deepEqual([...state.taintedMonths].sort(), [
    "2026-01",
    "2026-02",
  ]);
});

test("adjustCumulativeBeforeForPrependedRows subtracts actuals by direction", () => {
  const cumulativeBefore: CumulativeBefore = {
    incomeActual: 1000,
    spendActual: 400,
    transferActual: 120,
  };

  const adjusted = adjustCumulativeBeforeForPrependedRows(cumulativeBefore, [
    createBudgetRow({
      direction: "income",
      actual: 300,
    }),
    createBudgetRow({
      direction: "spend",
      actual: 50,
    }),
    createBudgetRow({
      direction: "transfer",
      actual: 20,
    }),
    createBudgetRow({
      direction: "income",
      actual: 100,
    }),
  ]);

  assert.deepEqual(adjusted, {
    incomeActual: 600,
    spendActual: 350,
    transferActual: 100,
  });
});
