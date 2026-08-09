import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import { buildBlocks } from "@/ui/tables/budget/model/blocks";

const budgetRow = (
  category: string,
  planned: number,
): BudgetRow => ({
  month: "2026-02",
  direction: "spend",
  category,
  plannedBase: planned,
  plannedModifier: 0,
  planned,
  actual: 0,
  hasUnconvertible: false,
});

const spendCategories = (
  rows: ReadonlyArray<BudgetRow>,
  allowlist: ReadonlySet<string> | null,
): ReadonlyArray<string> => {
  const blocks = buildBlocks(rows, ["2026-02"], "2026-02", allowlist);
  const block = blocks[0];
  assert.ok(block);
  return block.categories;
};

test("puts every visible category before every masked category in filtered mode", (): void => {
  const rows = [
    budgetRow("masked-high", 1_000),
    budgetRow("visible-low", 10),
    budgetRow("masked-low", 1),
    budgetRow("visible-high", 100),
  ];

  assert.deepEqual(
    spendCategories(rows, new Set(["visible-low", "visible-high"])),
    ["visible-high", "visible-low", "masked-high", "masked-low"],
  );
});

test("sorts visible categories by effective value in filtered mode", (): void => {
  const rows = [
    budgetRow("visible-low", 10),
    budgetRow("visible-high", 100),
    budgetRow("visible-middle", 50),
  ];

  assert.deepEqual(
    spendCategories(rows, new Set(["visible-low", "visible-high", "visible-middle"])),
    ["visible-high", "visible-middle", "visible-low"],
  );
});

test("keeps masked categories in source order when their amounts invert", (): void => {
  const allowlist = new Set(["visible"]);
  const highThenLow = [
    budgetRow("masked-first", 100),
    budgetRow("masked-second", 10),
    budgetRow("visible", 50),
  ];
  const lowThenHigh = [
    budgetRow("masked-first", 10),
    budgetRow("masked-second", 100),
    budgetRow("visible", 50),
  ];

  assert.deepEqual(
    spendCategories(highThenLow, allowlist),
    ["visible", "masked-first", "masked-second"],
  );
  assert.deepEqual(
    spendCategories(lowThenHigh, allowlist),
    ["visible", "masked-first", "masked-second"],
  );
});

test("sorts every category by effective value in all mode", (): void => {
  const rows = [
    budgetRow("low", 10),
    budgetRow("high", 100),
    budgetRow("middle", 50),
  ];

  assert.deepEqual(
    spendCategories(rows, null),
    ["high", "middle", "low"],
  );
});
