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

const assertPolicyError = (sql: string, expectedCode: SqlPolicyError["code"]): void => {
  assert.throws(
    () => validateExpenseSql(sql),
    (error: unknown) => error instanceof SqlPolicyError && error.code === expectedCode,
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

test("validateExpenseSql allows grouping and derived subqueries after SQL keywords", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (kind = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE (kind = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (kind = 'income')",
    "SELECT account_id FROM (SELECT account_id FROM ledger_entries) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT account_id FROM accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("validateExpenseSql inspects functions nested in grouping and derived subqueries", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (lower(kind) = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE (lower(kind) = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (lower(kind) = 'income')",
    "SELECT account_id FROM (SELECT lower(account_id) AS account_id FROM ledger_entries) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT lower(account_id) AS account_id FROM accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql rejects schema-qualified grammar keywords as function calls", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT custom.and(1)",
    "SELECT custom.or(1)",
    "SELECT custom.where(1)",
    "SELECT custom.from(1)",
    "SELECT custom.join(1)",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql inspects relations nested in grouping and derived subqueries", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM ledger_entries WHERE (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM (SELECT account_id FROM private_accounts) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT account_id FROM private_accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of rejectedSql) {
    assertPolicyError(sql, "relation_not_allowed");
  }
});

test("validateExpenseSql rejects parenthesized joined tables", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT * FROM (private_accounts JOIN accounts ON true)",
    "SELECT * FROM accounts JOIN (private_accounts JOIN ledger_entries ON true) ON true",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql allows comment and quote markers inside string literals", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT '\"' AS marker FROM ledger_entries",
    "SELECT '--' AS marker FROM ledger_entries",
    "SELECT '/*' AS marker FROM ledger_entries",
    "SELECT 'customer''s \" -- /*' AS marker FROM ledger_entries",
    "SELECT 'E''value' AS marker FROM ledger_entries",
    "SELECT '$5 and $tag$' AS marker FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("validateExpenseSql rejects syntax markers outside string literals with specific errors", (): void => {
  assertPolicyError("SELECT \"account_id\" FROM ledger_entries", "quoted_identifiers_not_allowed");
  assertPolicyError("SELECT account_id FROM ledger_entries -- comment", "sql_comments_not_allowed");
  assertPolicyError("SELECT /* comment */ account_id FROM ledger_entries", "sql_comments_not_allowed");
  assertPolicyError("SELECT $tag$value$tag$ FROM ledger_entries", "dollar_quoted_strings_not_allowed");
  assertPolicyError("SELECT 'unterminated FROM ledger_entries", "unterminated_string_literal");
});

test("validateExpenseSql rejects dollar signs in unquoted function identifiers", (): void => {
  assertPolicyError("SELECT evil$and(1)", "dollar_quoted_strings_not_allowed");
  assertPolicyError("SELECT public.evil$and(1)", "dollar_quoted_strings_not_allowed");
});

test("validateExpenseSql rejects escape strings before they can conceal restricted syntax", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT E'a\\'b' FROM \"ledger_entries\" WHERE 'x' = E'c\\'d'",
    "SELECT e'a\\'b' /* comment */ FROM ledger_entries WHERE 'x' = e'c\\'d'",
    "SELECT E'a\\'b' FROM private_accounts WHERE 'x' = E'c\\'d'",
    "SELECT e'a\\'b', pg_sleep(1), e'c\\'d'",
  ];

  for (const sql of rejectedSql) {
    assertPolicyError(sql, "escape_string_literals_not_allowed");
  }
});

test("validateExpenseSql allows typed literals with type names ending in e", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT DATE'2026-08-09' AS report_date FROM ledger_entries",
    "SELECT TIME'12:00:00' AS report_time FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("restricted SQL policy does not expose internal or removed relations", (): void => {
  assert.deepEqual(
    getAllowedRelationNames().filter((relationName) => relationName.startsWith("community")),
    [],
  );

  const rejectedRelations: ReadonlyArray<string> = [
    "SELECT * FROM community.monthly_category_shares",
    "SELECT * FROM monthly_category_shares",
    "SELECT * FROM budget_comments",
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
