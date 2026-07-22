import assert from "node:assert/strict";
import test from "node:test";

import { getCurrentMonth, offsetMonth } from "@/lib/monthUtils";
import { BUDGET_ADJUSTMENTS_DETAIL_QUERY, buildPatchBudgetAdjustmentQuery, mapBudgetAdjustmentRow } from "@/server/budget/budgetAdjustments";
import { getDemoBudgetGrid } from "@/server/demo/data";

test("mapBudgetAdjustmentRow returns the browser contract without workspace or origin", (): void => {
  const createdAt = new Date("2026-07-20T10:00:00.000Z");
  const updatedAt = new Date("2026-07-21T11:00:00.000Z");
  const adjustment = mapBudgetAdjustmentRow({
    adjustment_id: "adjustment-1",
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
    amount: -20,
    note: null,
    created_at: createdAt,
    updated_at: updatedAt,
  }, "test");

  assert.deepEqual(adjustment, {
    adjustmentId: "adjustment-1",
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
    amount: -20,
    note: null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
  assert.equal("workspaceId" in adjustment, false);
  assert.equal("origin" in adjustment, false);
});

test("mapBudgetAdjustmentRow accepts JavaScript safe-integer boundaries", (): void => {
  for (const amount of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    assert.equal(mapBudgetAdjustmentRow({
      adjustment_id: `adjustment-${amount}`,
      month: "2026-08",
      direction: "income",
      category: "Boundary",
      amount,
      note: null,
      created_at: new Date("2026-07-20T10:00:00.000Z"),
      updated_at: new Date("2026-07-20T10:00:00.000Z"),
    }, "boundary test").amount, amount);
  }
});

test("mapBudgetAdjustmentRow counts category and note limits in Unicode code points", (): void => {
  const category = "\u{1F600}".repeat(200);
  const note = "\u{1F680}".repeat(2000);
  const validRow = {
    adjustment_id: "adjustment-unicode-boundary",
    month: "2026-08",
    direction: "income",
    category,
    amount: 0,
    note,
    created_at: new Date("2026-07-20T10:00:00.000Z"),
    updated_at: new Date("2026-07-20T10:00:00.000Z"),
  } as const;

  const adjustment = mapBudgetAdjustmentRow(validRow, "Unicode boundary test");
  assert.equal(adjustment.category, category);
  assert.equal(adjustment.note, note);
  assert.throws(
    () => mapBudgetAdjustmentRow({
      ...validRow,
      category: "\u{1F600}".repeat(201),
    }, "Unicode category overflow test"),
    /Invalid budget adjustment database row.*category/,
  );
  assert.throws(
    () => mapBudgetAdjustmentRow({
      ...validRow,
      note: "\u{1F680}".repeat(2001),
    }, "Unicode note overflow test"),
    /Invalid budget adjustment database row.*note/,
  );
});

test("mapBudgetAdjustmentRow rejects invalid database values", (): void => {
  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-1",
      month: "2026-08",
      direction: "spend",
      category: "Groceries",
      amount: 1.5,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*amount/,
  );

  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-empty-category",
      month: "2026-08",
      direction: "spend",
      category: "",
      amount: 1,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*category/,
  );
  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-unsafe-amount",
      month: "2026-08",
      direction: "spend",
      category: "Groceries",
      amount: Number.MAX_SAFE_INTEGER + 1,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*amount/,
  );
});

test("patch query changes only supplied editable columns and scopes by workspace and id", (): void => {
  const query = buildPatchBudgetAdjustmentQuery("workspace-1", "adjustment-1", {
    amount: 0,
    note: null,
    month: "2026-09",
    category: "Dining",
  });

  assert.deepEqual(query.params, ["workspace-1", "adjustment-1", 0, null, "2026-09", "Dining"]);
  assert.match(query.text, /amount = \$3/);
  assert.match(query.text, /note = \$4/);
  assert.match(query.text, /budget_month = to_date\(\$5, 'YYYY-MM'\)/);
  assert.match(query.text, /category = \$6/);
  assert.match(query.text, /WHERE workspace_id = \$1\s+AND adjustment_id = \$2/);
  assert.doesNotMatch(query.text, /SET[^]*direction\s*=/);
  assert.doesNotMatch(query.text, /origin\s*=/);
});

test("detail query is one deterministic workspace and month-range scan", (): void => {
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /WHERE workspace_id = \$1/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /budget_month >= to_date\(\$2, 'YYYY-MM'\)/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /budget_month < \(to_date\(\$3, 'YYYY-MM'\) \+ interval '1 month'\)::date/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /ORDER BY budget_month, direction, category, created_at, adjustment_id/);
});

test("demo adjustment details exactly match cell modifiers and include adjustment-only cells", (): void => {
  const currentMonth = getCurrentMonth();
  const nextMonth = offsetMonth(currentMonth, 1);
  const grid = getDemoBudgetGrid(currentMonth, nextMonth, currentMonth, currentMonth);
  const sums = new Map<string, number>();

  for (const adjustment of grid.adjustments) {
    const key = `${adjustment.month}|${adjustment.direction}|${adjustment.category}`;
    sums.set(key, (sums.get(key) ?? 0) + adjustment.amount);
  }

  for (const [key, sum] of sums) {
    const [month, direction, category] = key.split("|");
    const row = grid.rows.find((candidate) =>
      candidate.month === month
      && candidate.direction === direction
      && candidate.category === category);
    assert.ok(row, `Missing demo budget row for ${key}`);
    assert.equal(row.plannedModifier, sum);
    assert.equal(row.planned, row.plannedBase + sum);
  }

  const adjustmentOnly = grid.rows.find((row) =>
    row.month === nextMonth && row.direction === "spend" && row.category === "Travel reserve");
  assert.ok(adjustmentOnly);
  assert.equal(adjustmentOnly.plannedBase, 0);
  assert.equal(adjustmentOnly.plannedModifier, 300);
  assert.equal(adjustmentOnly.planned, 300);
});
