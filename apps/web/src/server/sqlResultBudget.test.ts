import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SQL_RESULT_CHARS } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  applySqlResultCharBudget,
  applyStagedSqlResultCharBudget,
  type BudgetedSqlShrinkStage,
  type BudgetedSqlStatement,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";

type TestStatement = BudgetedSqlStatement & Readonly<{
  sql: string;
  totalRowCount: number;
}>;

// Stands in for the agent SQL surface's per-statement hints: a re-readable field
// of fixed size that no row cut can pay for.
type HintedTestStatement = TestStatement & Readonly<{
  hints?: string;
}>;

// The discrete stage the agent SQL surface passes, which rebuilds every entry
// without the sheddable field before the row search runs over it.
const WITHOUT_HINTS_STAGE: BudgetedSqlShrinkStage<HintedTestStatement> = {
  build: (entry) => ({
    ...entry,
    statement: {
      sql: entry.statement.sql,
      rows: entry.statement.rows,
      rowCount: entry.statement.rowCount,
      returnedRowCount: entry.statement.returnedRowCount,
      totalRowCount: entry.statement.totalRowCount,
      truncated: entry.statement.truncated,
    },
  }),
  shrunk: true,
};

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

// Wide enough that the hints alone cost more than a row, as the shared hints of
// one referenced relation do.
const HINT_CHARS = 1_200;

const createHintedStatement = (sql: string, rowCount: number): HintedTestStatement => ({
  ...createStatement(sql, rowCount),
  hints: "h".repeat(HINT_CHARS),
});

const measureHinted = (candidate: ReadonlyArray<HintedTestStatement>): number =>
  JSON.stringify({ statements: candidate }).length;

const asHintedReads = (
  statements: ReadonlyArray<HintedTestStatement>,
): ReadonlyArray<BudgetedSqlStatementEntry<HintedTestStatement>> =>
  statements.map((statement) => ({ statement, isMutating: false }));

const withoutRows = (statement: HintedTestStatement): HintedTestStatement => ({
  ...statement,
  rows: [],
  rowCount: 0,
  returnedRowCount: 0,
  truncated: true,
});

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

test("applyStagedSqlResultCharBudget drops rows before it sheds a stage", (): void => {
  const statements = [createHintedStatement("SELECT entry_id, note FROM ledger_entries LIMIT 100", 100)];
  assert.ok(measureHinted(statements) > MAX_SQL_RESULT_CHARS);

  const budgeted = applyStagedSqlResultCharBudget(
    asHintedReads(statements),
    measureHinted,
    [WITHOUT_HINTS_STAGE],
  );
  const statement = budgeted.statements[0];

  assert.ok(statement);
  assert.ok(measureHinted(budgeted.statements) <= MAX_SQL_RESULT_CHARS);
  // Rows paid for the budget on their own, so the hints survived untouched.
  assert.equal(budgeted.shrunk, false);
  assert.equal(statement.hints, "h".repeat(HINT_CHARS));
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < 100);
});

test("applyStagedSqlResultCharBudget sheds a stage when no row prefix pays for it", (): void => {
  const oversizedText = createHintedStatement(
    `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS - 1_000)}'`,
    10,
  );
  // This text leaves room for rows or for hints, but not for both: the unshrunk
  // stage is over budget with every row already dropped, while the shed stage
  // fits, so only shedding the hints can save the statement.
  assert.ok(measureHinted([withoutRows(oversizedText)]) > MAX_SQL_RESULT_CHARS);
  assert.ok(measureHinted([WITHOUT_HINTS_STAGE.build({
    statement: withoutRows(oversizedText),
    isMutating: false,
  }).statement]) <= MAX_SQL_RESULT_CHARS);

  const budgeted = applyStagedSqlResultCharBudget(
    asHintedReads([oversizedText]),
    measureHinted,
    [WITHOUT_HINTS_STAGE],
  );
  const statement = budgeted.statements[0];

  assert.ok(statement);
  assert.ok(measureHinted(budgeted.statements) <= MAX_SQL_RESULT_CHARS);
  assert.equal(budgeted.shrunk, true);
  assert.equal(statement.hints, undefined);
  // The shed stage searched the full row set again instead of inheriting the
  // zero rows the previous stage ended on, so the room it freed ships a row.
  assert.ok(statement.rows.length > 0);
  assert.equal(statement.totalRowCount, 10);
});

test("applyStagedSqlResultCharBudget prefers a later stage with rows over an earlier one that fits at zero rows", (): void => {
  const rowCount = 10;
  // Sized so the hinted statement fits the budget exactly once every row is gone:
  // a zero-row prefix is a fit, so without a guard the unshrunk stage would win and
  // spend the whole answer on hints the caller can read again.
  const paddingChars = MAX_SQL_RESULT_CHARS
    - measureHinted([withoutRows(createHintedStatement("", rowCount))]);
  const oversizedText = createHintedStatement("n".repeat(paddingChars), rowCount);
  assert.equal(measureHinted([withoutRows(oversizedText)]), MAX_SQL_RESULT_CHARS);
  assert.ok(measureHinted([oversizedText]) > MAX_SQL_RESULT_CHARS);

  const budgeted = applyStagedSqlResultCharBudget(
    asHintedReads([oversizedText]),
    measureHinted,
    [WITHOUT_HINTS_STAGE],
  );
  const statement = budgeted.statements[0];

  assert.ok(statement);
  assert.ok(measureHinted(budgeted.statements) <= MAX_SQL_RESULT_CHARS);
  // The hints are wider than a row, so shedding them buys rows back: a stage that
  // returns data outranks an earlier one that returns none.
  assert.equal(budgeted.shrunk, true);
  assert.equal(statement.hints, undefined);
  assert.ok(statement.rows.length > 0);
  assert.equal(statement.totalRowCount, rowCount);
});

test("applyStagedSqlResultCharBudget keeps the hints of a result that has no row to ship", (): void => {
  // Nothing is displaced when the statement returned no rows, so the guard above
  // must leave an empty result on its first stage instead of shedding a field and
  // reporting a shrink that bought nothing.
  const empty = createHintedStatement(
    "SELECT entry_id, note FROM ledger_entries WHERE entry_id = 'missing'",
    0,
  );

  const budgeted = applyStagedSqlResultCharBudget(
    asHintedReads([empty]),
    measureHinted,
    [WITHOUT_HINTS_STAGE],
  );
  const statement = budgeted.statements[0];

  assert.ok(statement);
  assert.equal(budgeted.shrunk, false);
  assert.deepEqual(statement, empty);
});

test("applyStagedSqlResultCharBudget ships the smallest stage when nothing fits", (): void => {
  const statements = [createHintedStatement(
    `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS)}'`,
    2,
  )];

  const budgeted = applyStagedSqlResultCharBudget(
    asHintedReads(statements),
    measureHinted,
    [WITHOUT_HINTS_STAGE],
  );
  const statement = budgeted.statements[0];

  assert.ok(statement);
  // The response ships over budget rather than failing a read that already ran,
  // but it ships the smallest payload: no rows and no sheddable field.
  assert.ok(measureHinted(budgeted.statements) > MAX_SQL_RESULT_CHARS);
  assert.equal(budgeted.shrunk, true);
  assert.equal(statement.hints, undefined);
  assert.equal(statement.rows.length, 0);
  assert.equal(statement.rowCount, 0);
  assert.equal(statement.returnedRowCount, 0);
  assert.equal(statement.totalRowCount, 2);
  assert.equal(statement.truncated, true);
});
