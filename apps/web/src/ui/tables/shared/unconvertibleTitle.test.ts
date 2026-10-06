import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { buildBudgetTaintedState } from "@/ui/tables/budget/model/balances";
import {
  buildUnconvertibleCurrenciesTitle,
  buildUnconvertibleMonthsTitle,
} from "@/ui/tables/shared/unconvertibleTitle";

const formatReason = (currencies: string): string => `no rate for ${currencies}`;

const budgetRow = (
  month: string,
  category: string,
  unconvertibleCurrencies: ReadonlyArray<string>,
): BudgetRow => ({
  month,
  direction: "spend",
  category,
  plannedBase: 0,
  plannedModifier: 0,
  planned: 0,
  actual: 0,
  hasUnconvertible: unconvertibleCurrencies.length > 0,
  unconvertibleCurrencies,
  hasActualRows: false,
});

test("buildUnconvertibleCurrenciesTitle returns no reason for an empty currency list", (): void => {
  assert.equal(buildUnconvertibleCurrenciesTitle([], formatReason), null);
});

test("buildUnconvertibleCurrenciesTitle names a single currency", (): void => {
  assert.equal(buildUnconvertibleCurrenciesTitle(["GRAM"], formatReason), "no rate for GRAM");
});

test("buildUnconvertibleCurrenciesTitle sorts several currencies", (): void => {
  assert.equal(
    buildUnconvertibleCurrenciesTitle(["USDT", "GRAM", "RSD"], formatReason),
    "no rate for GRAM, RSD, USDT",
  );
});

test("buildUnconvertibleMonthsTitle returns no reason when no month matches", (): void => {
  const currenciesByMonth = new Map([["2026-01", ["GRAM"]]]);
  assert.equal(
    buildUnconvertibleMonthsTitle(currenciesByMonth, (month) => month === "2026-02", formatReason),
    null,
  );
});

test("buildUnconvertibleMonthsTitle reports the currencies of the single matching month", (): void => {
  const currenciesByMonth = new Map([
    ["2026-01", ["GRAM"]],
    ["2026-02", ["RSD"]],
  ]);
  assert.equal(
    buildUnconvertibleMonthsTitle(currenciesByMonth, (month) => month === "2026-02", formatReason),
    "no rate for RSD",
  );
});

test("buildUnconvertibleMonthsTitle unions and sorts the currencies of every included month", (): void => {
  const currenciesByMonth = new Map([
    ["2026-01", ["USDT", "GRAM"]],
    ["2026-02", ["GRAM"]],
    ["2026-03", ["RSD"]],
    ["2025-12", ["UAH"]],
  ]);
  assert.equal(
    buildUnconvertibleMonthsTitle(currenciesByMonth, (month) => month.startsWith("2026-"), formatReason),
    "no rate for GRAM, RSD, USDT",
  );
});

test("buildBudgetTaintedState keys the currency union by month", (): void => {
  const state = buildBudgetTaintedState([
    budgetRow("2026-01", "food", ["USDT", "GRAM"]),
    budgetRow("2026-01", "rent", ["GRAM", "RSD"]),
    budgetRow("2026-02", "food", ["RSD"]),
    budgetRow("2026-03", "food", []),
  ]);

  assert.deepEqual([...state.unconvertibleCurrenciesByMonth.keys()], ["2026-01", "2026-02"]);
  assert.deepEqual(state.unconvertibleCurrenciesByMonth.get("2026-01"), ["GRAM", "RSD", "USDT"]);
  assert.deepEqual(state.unconvertibleCurrenciesByMonth.get("2026-02"), ["RSD"]);
  assert.equal(state.unconvertibleCurrenciesByMonth.has("2026-03"), false);
});
