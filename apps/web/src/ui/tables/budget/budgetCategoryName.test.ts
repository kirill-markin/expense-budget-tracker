import assert from "node:assert/strict";
import test from "node:test";

import {
  BUDGET_CATEGORY_NAME_MAX_LENGTH,
  parseBudgetCategoryName,
} from "@/ui/tables/budget/budgetCategoryName";

test("trims the typed name", (): void => {
  assert.deepEqual(parseBudgetCategoryName("  Coffee  "), { ok: true, name: "Coffee" });
});

test("rejects a name that is empty or only whitespace", (): void => {
  assert.deepEqual(parseBudgetCategoryName(""), { ok: false, error: "empty" });
  assert.deepEqual(parseBudgetCategoryName("   \n\t "), { ok: false, error: "empty" });
});

test("accepts a name of exactly the database column length", (): void => {
  const name = "c".repeat(BUDGET_CATEGORY_NAME_MAX_LENGTH);
  assert.deepEqual(parseBudgetCategoryName(name), { ok: true, name });
});

test("rejects a name longer than the database column length", (): void => {
  assert.deepEqual(
    parseBudgetCategoryName("c".repeat(BUDGET_CATEGORY_NAME_MAX_LENGTH + 1)),
    { ok: false, error: "tooLong" },
  );
});

test("counts code points, not UTF-16 code units, like the API and the database", (): void => {
  const name = "🙂".repeat(BUDGET_CATEGORY_NAME_MAX_LENGTH);
  assert.deepEqual(parseBudgetCategoryName(name), { ok: true, name });
  assert.deepEqual(
    parseBudgetCategoryName("🙂".repeat(BUDGET_CATEGORY_NAME_MAX_LENGTH + 1)),
    { ok: false, error: "tooLong" },
  );
});

test("measures the length after trimming", (): void => {
  const name = "c".repeat(BUDGET_CATEGORY_NAME_MAX_LENGTH);
  assert.deepEqual(parseBudgetCategoryName(`  ${name}  `), { ok: true, name });
});
