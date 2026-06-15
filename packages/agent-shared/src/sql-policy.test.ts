import assert from "node:assert/strict";
import test from "node:test";
import {
  executeExpenseSql,
  getAllowedRelationNames,
  MAX_SQL_ROWS,
  SqlPolicyError,
  validateExpenseSql,
} from "./sql-policy.js";

const assertFunctionCallRejected = (sql: string): void => {
  assert.throws(
    () => validateExpenseSql(sql),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "function_calls_not_allowed"
      && error.message.includes("Allowed functions: SUM, COUNT, MIN, MAX, AVG, COALESCE"),
  );
};

test("validateExpenseSql allows allowlisted aggregate functions", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    "SELECT COUNT(*) AS cnt FROM ledger_entries",
    "SELECT kind, COUNT(*) AS cnt, SUM(amount) AS total FROM ledger_entries GROUP BY kind",
    "SELECT account_id, currency, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id, currency ORDER BY account_id",
    "SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    "SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, AVG(amount) AS average_amount FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    const validated = validateExpenseSql(sql);
    assert.equal(validated.statements.length, 1);
    assert.deepEqual(validated.statements[0]?.referencedRelations, ["ledger_entries"]);
  }
});

test("validateExpenseSql rejects non-allowlisted function calls in restricted SQL", (): void => {
  assertFunctionCallRejected("SELECT delete_workspace_for_current_user('x')");
  assertFunctionCallRejected("SELECT now()");
  assertFunctionCallRejected("SELECT account_id FROM ledger_entries ORDER BY lower(account_id)");
  assertFunctionCallRejected("SELECT pg_sleep(1)");
  assertFunctionCallRejected("WITH x AS (SELECT delete_workspace_for_current_user('x')) SELECT * FROM x");
  assertFunctionCallRejected("SELECT count(delete_workspace_for_current_user('x'))");
  assertFunctionCallRejected("INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id) VALUES (gen_random_uuid(), now(), 'a-main-usd', 1, 'USD', 'income', 'workspace-1')");
});

test("validateExpenseSql still rejects set_config before function allowlist checks", (): void => {
  assert.throws(
    () => validateExpenseSql("SELECT set_config('app.user_id', 'user-1', true)"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "set_config_not_allowed"
      && error.message === "set_config() calls are not allowed",
  );
});

test("validateExpenseSql still allows direct relation queries without function calls", (): void => {
  const validated = validateExpenseSql("SELECT account_id FROM ledger_entries ORDER BY account_id LIMIT 1");
  assert.equal(validated.statements.length, 1);
  assert.deepEqual(validated.statements[0]?.referencedRelations, ["ledger_entries"]);
});

test("restricted SQL policy does not expose community public share objects", (): void => {
  assert.deepEqual(
    getAllowedRelationNames().filter((relationName) => relationName.startsWith("community")),
    [],
  );

  const rejectedRelations: ReadonlyArray<string> = [
    "SELECT * FROM community.monthly_category_shares",
    "SELECT * FROM monthly_category_shares",
  ];

  for (const sql of rejectedRelations) {
    assert.throws(
      () => validateExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError && error.code === "relation_not_allowed",
    );
  }

  assert.throws(
    () => validateExpenseSql("SELECT * FROM community.read_public_monthly_category_share('token', '2025-01-01', '2025-12-01')"),
    (error: unknown) =>
      error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );
});

test("executeExpenseSql reports truncation metadata without removing rowCount", async (): Promise<void> => {
  const sourceRows: ReadonlyArray<Readonly<Record<string, unknown>>> = Array.from(
    { length: MAX_SQL_ROWS + 1 },
    (_value, index) => ({ account_id: `account-${String(index)}` }),
  );

  const executed = await executeExpenseSql(
    "SELECT account_id FROM ledger_entries ORDER BY account_id",
    async () => ({
      command: "SELECT",
      rows: sourceRows,
      rowCount: sourceRows.length,
    }),
  );

  const statement = executed.statements[0];
  assert.equal(statement?.rowCount, MAX_SQL_ROWS);
  assert.equal(statement?.returnedRowCount, MAX_SQL_ROWS);
  assert.equal(statement?.totalRowCount, MAX_SQL_ROWS + 1);
  assert.equal(statement?.truncated, true);
});
