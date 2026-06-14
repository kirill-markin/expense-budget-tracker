import assert from "node:assert/strict";
import test from "node:test";

import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import {
  buildPublicMonthlyShareTableModel,
  mergePublicMonthlyShareWindows,
} from "@/ui/public-share/publicMonthlyShareModel";

const createShare = (
  loadedMonthFrom: string,
  loadedMonthTo: string,
  cells: PublicMonthlyCategoryShare["cells"],
  yearTotals: PublicMonthlyCategoryShare["yearTotals"],
): PublicMonthlyCategoryShare => ({
  label: "Shared spend",
  currency: "USD",
  availableMonthFrom: "2024-12",
  availableMonthTo: "2025-03",
  loadedMonthFrom,
  loadedMonthTo,
  categories: [
    { category: "Groceries", accessLevel: "monthly_values" },
  ],
  cells,
  yearTotals,
});

test("mergePublicMonthlyShareWindows recomputes year totals from loaded public cells", (): void => {
  const currentShare = createShare(
    "2025-03",
    "2025-03",
    [
      { month: "2025-03", category: "Groceries", amount: 30 },
    ],
    [
      { year: "2025", category: "Groceries", amount: 999 },
    ],
  );
  const fetchedShare = createShare(
    "2024-12",
    "2025-02",
    [
      { month: "2024-12", category: "Groceries", amount: 5 },
      { month: "2025-01", category: "Groceries", amount: 10 },
    ],
    [
      { year: "2024", category: "Groceries", amount: 999 },
      { year: "2025", category: "Groceries", amount: 999 },
    ],
  );

  const merged = mergePublicMonthlyShareWindows(currentShare, fetchedShare);
  const model = buildPublicMonthlyShareTableModel(merged);
  const groceryRow = model.rows.find((row) => row.category === "Groceries");

  assert.deepEqual(merged.yearTotals, [
    { year: "2024", category: "Groceries", amount: 5 },
    { year: "2025", category: "Groceries", amount: 40 },
  ]);
  assert.ok(groceryRow !== undefined);
  assert.equal(groceryRow.yearTotals.get("2024"), 5);
  assert.equal(groceryRow.yearTotals.get("2025"), 40);
});
