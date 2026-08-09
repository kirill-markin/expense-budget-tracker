import assert from "node:assert/strict";
import test from "node:test";

import { generateMonthRange } from "@/lib/monthUtils";
import {
  buildColumnSequence,
  getBudgetDisplayRange,
  getBudgetRangeExtension,
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
