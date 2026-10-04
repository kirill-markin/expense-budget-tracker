import assert from "node:assert/strict";
import test from "node:test";

import { generateMonthRange } from "@/lib/monthUtils";
import {
  buildBudgetValueColumns,
  buildColumnSequence,
  getBudgetDisplayRange,
  getBudgetRangeExtension,
  getTargetFillMonths,
  isBudgetFillSourceMonth,
  isBudgetMonthLoaded,
} from "@/ui/tables/budget/model/dateRanges";

test("builds the fixed budget calendar from January ten years ago through December ten years ahead", (): void => {
  const displayRange = getBudgetDisplayRange("2026-08");
  const months = generateMonthRange(displayRange.monthFrom, displayRange.monthTo);
  const columns = buildColumnSequence(months);

  assert.deepEqual(displayRange, {
    monthFrom: "2016-01",
    monthTo: "2036-12",
  });
  assert.equal(months.length, 21 * 12);
  assert.equal(columns.length, 21 * 13);
  assert.deepEqual(columns[0], { kind: "month", month: "2016-01" });
  assert.deepEqual(columns.at(-1), { kind: "year-total", year: "2036" });
});

test("loads one contiguous extension across a far scrollbar jump", (): void => {
  const extension = getBudgetRangeExtension(
    "2016-01",
    "2036-12",
    "2026-02",
    "2027-08",
    "2033-04",
    "2033-10",
    6,
  );

  assert.deepEqual(extension, {
    direction: "right",
    monthFrom: "2027-09",
    monthTo: "2034-03",
  });
});

test("caps viewport overscan at the fixed display boundary", (): void => {
  const extension = getBudgetRangeExtension(
    "2016-01",
    "2036-12",
    "2026-02",
    "2027-08",
    "2016-01",
    "2016-03",
    6,
  );

  assert.deepEqual(extension, {
    direction: "left",
    monthFrom: "2016-01",
    monthTo: "2026-01",
  });
});

test("flattens the fixed calendar into stable physical value columns", (): void => {
  const displayRange = getBudgetDisplayRange("2026-08");
  const months = generateMonthRange(displayRange.monthFrom, displayRange.monthTo);
  const valueColumns = buildBudgetValueColumns(
    buildColumnSequence(months),
    "2026-08",
    "actuals",
  );

  assert.equal(valueColumns.length, 21 * 13 + 2);
  assert.deepEqual(
    valueColumns.filter((column) => column.key.startsWith("2026-08")),
    [
      { key: "2026-08-plan", isYearTotal: false, currentMonthPart: "plan" },
      { key: "2026-08-actual", isYearTotal: false, currentMonthPart: "actual" },
    ],
  );
  assert.deepEqual(
    valueColumns.filter((column) => column.key.startsWith("total-2026")),
    [
      { key: "total-2026-plan", isYearTotal: true, currentMonthPart: null },
      { key: "total-2026-actual", isYearTotal: true, currentMonthPart: null },
    ],
  );
});

test("recognizes only months inside the contiguous loaded interval", (): void => {
  assert.equal(isBudgetMonthLoaded("2026-01", "2026-02", "2027-08"), false);
  assert.equal(isBudgetMonthLoaded("2026-02", "2026-02", "2027-08"), true);
  assert.equal(isBudgetMonthLoaded("2027-08", "2026-02", "2027-08"), true);
  assert.equal(isBudgetMonthLoaded("2027-09", "2026-02", "2027-08"), false);
});

test("splits every elapsed month and year in the all-plans mode", (): void => {
  const months = generateMonthRange("2025-11", "2026-10");
  const valueColumns = buildBudgetValueColumns(
    buildColumnSequence(months),
    "2026-02",
    "all-plans",
  );

  assert.deepEqual(valueColumns.map((column) => column.key), [
    "2025-11-plan", "2025-11-actual",
    "2025-12-plan", "2025-12-actual",
    "total-2025-plan", "total-2025-actual",
    "2026-01-plan", "2026-01-actual",
    "2026-02-plan", "2026-02-actual",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
    "2026-09",
    "2026-10",
  ]);
});

test("keeps one column per elapsed month and year in the default mode", (): void => {
  const months = generateMonthRange("2025-11", "2026-04");
  const valueColumns = buildBudgetValueColumns(
    buildColumnSequence(months),
    "2026-02",
    "actuals",
  );

  assert.deepEqual(valueColumns.map((column) => column.key), [
    "2025-11",
    "2025-12",
    "total-2025",
    "2026-01",
    "2026-02-plan", "2026-02-actual",
    "2026-03",
    "2026-04",
  ]);
});

test("offers a fill only from the current month onward", (): void => {
  assert.equal(isBudgetFillSourceMonth("2026-10", "2026-10"), true);
  assert.equal(isBudgetFillSourceMonth("2026-11", "2026-10"), true);
  assert.equal(isBudgetFillSourceMonth("2027-01", "2026-10"), true);
  // An elapsed month: its fill would rewrite the recorded plans of every later
  // month of that calendar year.
  assert.equal(isBudgetFillSourceMonth("2026-09", "2026-10"), false);
  assert.equal(isBudgetFillSourceMonth("2025-01", "2026-10"), false);
});

test("spans a fill from the month after the source through December", (): void => {
  assert.deepEqual(getTargetFillMonths("2026-10"), [
    "2026-11",
    "2026-12",
  ]);
  assert.deepEqual(getTargetFillMonths("2026-12"), []);
  // Every target of an elapsed source month is a month this mode shows as
  // history, which is why such a source is refused above.
  assert.equal(getTargetFillMonths("2026-01").length, 11);
});
