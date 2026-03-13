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

test("validateExpenseSql allows a CTE that reads allowed relations", () => {
  const result = validateExpenseSql("WITH recent AS (SELECT * FROM accounts) SELECT * FROM recent");
  assert.deepEqual(result.referencedRelations, ["accounts"]);
});

test("validateExpenseSql rejects CTE shadowing of a blocked relation", () => {
  assert.throws(
    () => validateExpenseSql("WITH workspace_members AS (SELECT * FROM workspace_members) SELECT * FROM accounts"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "relation_not_allowed"
      && error.message === "Relation workspace_members is not allowed",
  );
});

test("validateExpenseSql rejects blocked relations referenced through JOIN inside a CTE", () => {
  assert.throws(
    () => validateExpenseSql("WITH workspace_members AS (SELECT * FROM accounts a JOIN workspace_members wm ON true) SELECT * FROM accounts"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "relation_not_allowed"
      && error.message === "Relation workspace_members is not allowed",
  );
});

test("validateExpenseSql allows recursive CTE self-reference with allowed base relations", () => {
  const result = validateExpenseSql(
    "WITH RECURSIVE recent(account_id) AS (SELECT account_id FROM accounts UNION ALL SELECT account_id FROM recent WHERE 1 = 0) SELECT * FROM recent",
  );
  assert.deepEqual(result.referencedRelations, ["accounts"]);
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
