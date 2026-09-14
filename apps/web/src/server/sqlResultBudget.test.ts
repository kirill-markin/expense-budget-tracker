import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SQL_RESULT_CHARS } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  applySqlResultCharBudget,
  type BudgetedSqlStatement,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";

type TestStatement = BudgetedSqlStatement & Readonly<{
  sql: string;
  totalRowCount: number;
}>;

// 600-char notes, the row width that makes an ordinary 100-row read oversized.
const createRows = (rowCount: number): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  Array.from({ length: rowCount }, (_value, index) => ({
    entry_id: `entry-${String(index)}`,
    note: "н".repeat(600),
    amount: index,
  }));

const createStatement = (sql: string, rowCount: number): TestStatement => {
  const rows = createRows(rowCount);
  return {
    sql,
    rows,
    rowCount: rows.length,
    returnedRowCount: rows.length,
    totalRowCount: rows.length,
    truncated: false,
  };
};

const measure = (candidate: ReadonlyArray<TestStatement>): number =>
  JSON.stringify({ statements: candidate }).length;

const asReads = (
  statements: ReadonlyArray<TestStatement>,
): ReadonlyArray<BudgetedSqlStatementEntry<TestStatement>> =>
  statements.map((statement) => ({ statement, isMutating: false }));

test("applySqlResultCharBudget leaves a result that fits untouched", (): void => {
  const statements = [createStatement("SELECT entry_id, note FROM ledger_entries LIMIT 10", 10)];

  const budgeted = applySqlResultCharBudget(asReads(statements), measure);

  assert.ok(measure(budgeted) <= MAX_SQL_RESULT_CHARS);
  assert.deepEqual(budgeted, statements);
});

test("applySqlResultCharBudget keeps the largest fitting row prefix of an oversized result", (): void => {
  const statements = [createStatement("SELECT entry_id, note FROM ledger_entries LIMIT 100", 100)];
  assert.ok(measure(statements) > MAX_SQL_RESULT_CHARS);

  const budgeted = applySqlResultCharBudget(asReads(statements), measure);
  const statement = budgeted[0];

  assert.ok(statement);
  assert.ok(measure(budgeted) <= MAX_SQL_RESULT_CHARS);
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < 100);
  assert.equal(statement.rowCount, statement.rows.length);
  assert.equal(statement.returnedRowCount, statement.rows.length);
  assert.equal(statement.totalRowCount, 100);
  assert.equal(statement.truncated, true);
  assert.ok(measure([{
    ...statement,
    rows: createRows(statement.rows.length + 1),
    rowCount: statement.rows.length + 1,
    returnedRowCount: statement.rows.length + 1,
  }]) > MAX_SQL_RESULT_CHARS);
});

test("applySqlResultCharBudget spends one row budget in statement order", (): void => {
  const statements = [
    createStatement("SELECT entry_id, note FROM ledger_entries LIMIT 60", 60),
    createStatement("SELECT entry_id, note FROM ledger_entries OFFSET 60 LIMIT 60", 60),
  ];

  const budgeted = applySqlResultCharBudget(asReads(statements), measure);
  const [first, second] = budgeted;

  assert.ok(first);
  assert.ok(second);
  assert.ok(measure(budgeted) <= MAX_SQL_RESULT_CHARS);
  assert.ok(first.rows.length > 0);
  assert.equal(second.rows.length, 0);
  assert.equal(second.rowCount, 0);
  assert.equal(second.returnedRowCount, 0);
  assert.equal(second.totalRowCount, 60);
  assert.equal(second.truncated, true);
});

test("applySqlResultCharBudget keeps the affected row count of a statement with no rows to drop", (): void => {
  const mutation: TestStatement = {
    sql: "UPDATE ledger_entries SET note = 'x' WHERE entry_id = 'entry-1'",
    rows: [],
    rowCount: 5,
    returnedRowCount: 0,
    totalRowCount: 5,
    truncated: false,
  };
  const read = createStatement("SELECT entry_id, note FROM ledger_entries LIMIT 100", 100);

  const budgeted = applySqlResultCharBudget(
    [
      { statement: mutation, isMutating: true },
      { statement: read, isMutating: false },
    ],
    measure,
  );
  const [first] = budgeted;

  assert.ok(first);
  assert.ok(measure(budgeted) <= MAX_SQL_RESULT_CHARS);
  assert.deepEqual(first, mutation);
});

test("applySqlResultCharBudget keeps the affected row count when a mutation's rows are cut", (): void => {
  const returnedRowCount = 60;
  const mutation = createStatement(
    "INSERT INTO ledger_entries (entry_id, note) VALUES ('entry-1', 'н') RETURNING entry_id, note",
    returnedRowCount,
  );

  const budgeted = applySqlResultCharBudget([{ statement: mutation, isMutating: true }], measure);
  const statement = budgeted[0];

  assert.ok(statement);
  assert.ok(measure(budgeted) <= MAX_SQL_RESULT_CHARS);
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < returnedRowCount);
  // A committed mutation still reports the rows it affected, as the machine API
  // does, so a shorter result never reads as a partly applied write.
  assert.equal(statement.rowCount, returnedRowCount);
  assert.equal(statement.returnedRowCount, statement.rows.length);
  assert.equal(statement.totalRowCount, returnedRowCount);
  assert.equal(statement.truncated, true);
});

test("applySqlResultCharBudget drops every row instead of failing a read whose statement text is over budget", (): void => {
  const statements = [createStatement(
    `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS)}'`,
    2,
  )];

  const budgeted = applySqlResultCharBudget(asReads(statements), measure);
  const statement = budgeted[0];

  assert.ok(statement);
  assert.ok(measure(budgeted) > MAX_SQL_RESULT_CHARS);
  assert.equal(statement.rows.length, 0);
  assert.equal(statement.rowCount, 0);
  assert.equal(statement.returnedRowCount, 0);
  assert.equal(statement.totalRowCount, 2);
  assert.equal(statement.truncated, true);
});
