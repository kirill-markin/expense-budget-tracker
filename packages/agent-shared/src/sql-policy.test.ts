import assert from "node:assert/strict";
import test from "node:test";
import { SqlPolicyError, executeExpenseSql, getAllowedRelationNames, validateExpenseSql } from "./sql-policy.js";

test("getAllowedRelationNames returns the canonical relation list", () => {
  assert.deepEqual(getAllowedRelationNames(), [
    "ledger_entries",
    "accounts",
    "budget_lines",
    "budget_comments",
    "workspace_settings",
    "account_metadata",
    "exchange_rates",
  ]);
});

test("validateExpenseSql rejects multiple statements", () => {
  assert.throws(() => validateExpenseSql("SELECT 1; SELECT 2"), (error: unknown) =>
    error instanceof SqlPolicyError && error.code === "multiple_statements_not_allowed");
});

test("executeExpenseSql returns referenced relations and trimmed sql", async () => {
  const result = await executeExpenseSql(
    " SELECT * FROM accounts LIMIT 1 ",
    async (validatedSql) => {
      assert.equal(validatedSql, "SELECT * FROM accounts LIMIT 1");
      return {
        rows: [{ account_id: "checking" }],
        rowCount: 1,
      };
    },
  );

  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.referencedRelations, ["accounts"]);
});
