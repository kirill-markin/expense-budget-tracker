import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  isDirectionActualOverPlanned,
  isNegativeValueOver,
} from "./helpers";

test("buildDirectionYearDrillDownFilter preserves direction subtotal allowlist", () => {
  assert.deepEqual(
    buildDirectionYearDrillDownFilter("2026", "spend", ["Food", "Rent"]),
    {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      direction: "spend",
      category: null,
      categories: ["Food", "Rent"],
    },
  );
});

test("buildCategoryYearDrillDownFilter isolates a single category", () => {
  assert.deepEqual(
    buildCategoryYearDrillDownFilter("2026", "income", "Salary"),
    {
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
      direction: "income",
      category: "Salary",
      categories: null,
    },
  );
});

test("buildDirectionMonthDrillDownFilter preserves subtotal allowlist for a month", () => {
  assert.deepEqual(
    buildDirectionMonthDrillDownFilter("2026-03", "spend", ["Food", ""]),
    {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      direction: "spend",
      category: null,
      categories: ["Food", ""],
    },
  );
});

test("buildCategoryMonthDrillDownFilter does not carry allowlist categories", () => {
  assert.deepEqual(
    buildCategoryMonthDrillDownFilter("2026-03", "spend", "Food"),
    {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      direction: "spend",
      category: "Food",
      categories: null,
    },
  );
});

test("isDirectionActualOverPlanned only marks spend rows over plan", () => {
  assert.equal(isDirectionActualOverPlanned("spend", 100, 120), true);
  assert.equal(isDirectionActualOverPlanned("spend", 0, 120), false);
  assert.equal(isDirectionActualOverPlanned("income", 100, 120), false);
});

test("isNegativeValueOver marks only negative values", () => {
  assert.equal(isNegativeValueOver(-1), true);
  assert.equal(isNegativeValueOver(0), false);
  assert.equal(isNegativeValueOver(1), false);
});
