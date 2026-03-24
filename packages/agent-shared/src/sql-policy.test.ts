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

test("validateExpenseSql splits multiple statements and ignores trailing semicolons", () => {
  const result = validateExpenseSql(" SELECT 1 ; SELECT * FROM accounts LIMIT 1; ");

  assert.equal(result.sql, "SELECT 1 ; SELECT * FROM accounts LIMIT 1;");
  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    ["SELECT 1", "SELECT * FROM accounts LIMIT 1"],
  );
  assert.equal(result.statements[0]?.isMutating, false);
  assert.equal(result.statements[1]?.isMutating, false);
  assert.deepEqual(result.statements[0]?.referencedRelations, []);
  assert.deepEqual(result.statements[1]?.referencedRelations, ["accounts"]);
});

test("validateExpenseSql does not split semicolons inside single-quoted strings", () => {
  const result = validateExpenseSql("SELECT ';' AS marker; SELECT 'a; b' AS note");

  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    ["SELECT ';' AS marker", "SELECT 'a; b' AS note"],
  );
});

test("validateExpenseSql ignores empty statements between semicolons", () => {
  const result = validateExpenseSql(";; SELECT * FROM accounts;;;SELECT 1;;");

  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    ["SELECT * FROM accounts", "SELECT 1"],
  );
});

test("validateExpenseSql reports quoted identifier errors even when semicolons appear inside them", () => {
  assert.throws(
    () => validateExpenseSql("SELECT \"semi;colon\" FROM accounts"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "quoted_identifiers_not_allowed"
      && error.message === "Quoted identifiers are not allowed",
  );
});

test("validateExpenseSql reports SQL comments errors even when semicolons appear inside comments", () => {
  assert.throws(
    () => validateExpenseSql("SELECT 1 /* semi;colon */"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "sql_comments_not_allowed"
      && error.message === "SQL comments are not allowed",
  );
});

test("validateExpenseSql reports dollar-quoted string errors even when semicolons appear inside them", () => {
  assert.throws(
    () => validateExpenseSql("SELECT $$semi;colon$$"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "dollar_quoted_strings_not_allowed"
      && error.message === "Dollar-quoted strings are not allowed",
  );
});

test("validateExpenseSql allows a CTE that reads allowed relations", () => {
  const result = validateExpenseSql("WITH recent AS (SELECT * FROM accounts) SELECT * FROM recent");
  assert.equal(result.statements[0]?.isMutating, false);
  assert.deepEqual(result.statements[0]?.referencedRelations, ["accounts"]);
});

test("validateExpenseSql marks INSERT, UPDATE, and DELETE statements as mutating", () => {
  const result = validateExpenseSql(
    "INSERT INTO ledger_entries (entry_id) VALUES ('1'); UPDATE ledger_entries SET amount = 1; DELETE FROM ledger_entries WHERE entry_id = '1'",
  );

  assert.deepEqual(
    result.statements.map((statement) => statement.isMutating),
    [true, true, true],
  );
});

test("validateExpenseSql keeps read-only WITH statements non-mutating", () => {
  const result = validateExpenseSql(
    "WITH recent AS (SELECT * FROM accounts) SELECT * FROM recent",
  );

  assert.equal(result.statements[0]?.isMutating, false);
});

test("validateExpenseSql marks mutating WITH statements as mutating", () => {
  const result = validateExpenseSql(
    "WITH changed AS (UPDATE ledger_entries SET amount = 1 RETURNING entry_id) SELECT * FROM changed",
  );

  assert.equal(result.statements[0]?.isMutating, true);
});

test("validateExpenseSql marks mutating WITH statements that insert or delete as mutating", () => {
  const result = validateExpenseSql(
    "WITH inserted AS (INSERT INTO budget_comments (workspace_id, month, direction, category, comment) VALUES ('w', '2026-01', 'spend', 'Food', 'x') RETURNING workspace_id), removed AS (DELETE FROM budget_comments WHERE workspace_id = 'w' RETURNING workspace_id) SELECT * FROM inserted UNION ALL SELECT * FROM removed",
  );

  assert.equal(result.statements[0]?.isMutating, true);
});

test("validateExpenseSql rejects ON CONFLICT with a clear policy error", () => {
  assert.throws(
    () => validateExpenseSql("INSERT INTO account_metadata (workspace_id, account_id, liquidity) VALUES ('w', 'a-checking-eur', 'high') ON CONFLICT (workspace_id, account_id) DO UPDATE SET liquidity = 'medium'"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "on_conflict_not_allowed"
      && error.message === "ON CONFLICT is not supported in restricted SQL",
  );
});

test("validateExpenseSql rejects TABLE syntax at the top level", () => {
  assert.throws(
    () => validateExpenseSql("TABLE accounts"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
  );
});

test("validateExpenseSql rejects TABLE syntax for a blocked qualified relation", () => {
  assert.throws(
    () => validateExpenseSql("TABLE public.users"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
  );
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

test("validateExpenseSql rejects blocked TABLE syntax inside a CTE", () => {
  assert.throws(
    () => validateExpenseSql("WITH recent AS (TABLE users) SELECT * FROM accounts"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
  );
});

test("validateExpenseSql rejects TABLE syntax inside a CTE even for allowed relations", () => {
  assert.throws(
    () => validateExpenseSql("WITH recent AS (TABLE accounts) SELECT * FROM recent"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
  );
});

test("validateExpenseSql allows recursive CTE self-reference with allowed base relations", () => {
  const result = validateExpenseSql(
    "WITH RECURSIVE recent(account_id) AS (SELECT account_id FROM accounts UNION ALL SELECT account_id FROM recent WHERE 1 = 0) SELECT * FROM recent",
  );
  assert.deepEqual(result.statements[0]?.referencedRelations, ["accounts"]);
});

test("executeExpenseSql executes validated statements in order", async () => {
  const executedSql: Array<string> = [];

  const result = await executeExpenseSql(
    " SELECT * FROM accounts LIMIT 1; SELECT 1; ",
    async (validatedSql) => {
      executedSql.push(validatedSql);
      if (validatedSql === "SELECT * FROM accounts LIMIT 1") {
        return {
          command: "SELECT",
          rows: [{ account_id: "checking" }],
          rowCount: 1,
        };
      }

      return {
        command: "SELECT",
        rows: [{ "?column?": 1 }],
        rowCount: 1,
      };
    },
  );

  assert.equal(result.sql, "SELECT * FROM accounts LIMIT 1; SELECT 1;");
  assert.deepEqual(executedSql, [
    "SELECT * FROM accounts LIMIT 1",
    "SELECT 1",
  ]);
  assert.deepEqual(result.statements, [
    {
      sql: "SELECT * FROM accounts LIMIT 1",
      command: "SELECT",
      isMutating: false,
      rows: [{ account_id: "checking" }],
      rowCount: 1,
      referencedRelations: ["accounts"],
    },
    {
      sql: "SELECT 1",
      command: "SELECT",
      isMutating: false,
      rows: [{ "?column?": 1 }],
      rowCount: 1,
      referencedRelations: [],
    },
  ]);
});

test("executeExpenseSql validates the whole script before execution", async () => {
  let executeCalls = 0;

  await assert.rejects(
    executeExpenseSql(
      "SELECT * FROM accounts; TABLE users",
      async () => {
        executeCalls++;
        return {
          command: "SELECT",
          rows: [],
          rowCount: 0,
        };
      },
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
  );

  assert.equal(executeCalls, 0);
});
