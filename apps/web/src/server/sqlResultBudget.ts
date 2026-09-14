/**
 * Character budget for the SQL results the web app hands to an agent.
 *
 * Both web surfaces emit one whole result per call: the chat sends it into an
 * OpenAI turn that re-sends it on every later model call of the same turn, and
 * the agent SQL route returns it to an API-key client. Dropping rows is the
 * whole mechanism here, and a cut is reported through the fields the machine
 * API already uses: returnedRowCount becomes the rows actually shipped,
 * truncated is set, and totalRowCount keeps naming what the query matched.
 *
 * A read also lowers rowCount to the rows it shipped, while a committed
 * mutation keeps reporting the rows it affected, the same exemption
 * apps/sql-api/src/machineApi/sqlService.ts makes, so an agent never reads a
 * cut write result as a partly applied one. truncated still flags the drop on
 * both kinds, because these envelopes have no rowsOmitted field.
 */
import { MAX_SQL_RESULT_CHARS } from "@expense-budget-tracker/agent-shared/sql-policy";

/**
 * Premise of the row search below, which both callers satisfy: every field a
 * cut rewrites is non-decreasing in the kept row count, so rowCount and
 * returnedRowCount must be the statement's own rows.length whenever it returned
 * rows. A caller passing counts unrelated to rows.length would make candidate
 * sizes non-monotone and silently break the search.
 */
export type BudgetedSqlStatement = Readonly<{
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  returnedRowCount: number;
  truncated: boolean;
}>;

// isMutating travels beside the statement instead of inside it, because neither
// caller's agent-facing statement shape carries that flag. Pairing it with the
// statement keeps the two aligned without an index lookup.
export type BudgetedSqlStatementEntry<TStatement extends BudgetedSqlStatement> = Readonly<{
  statement: TStatement;
  isMutating: boolean;
}>;

// The spread keeps every field the caller's own statement type adds, which the
// compiler cannot express as the same type parameter, so the result is asserted
// back to it. The branch reads isMutating, which is fixed per statement before
// the search starts; nothing here may depend on the candidate's size, or the
// monotonicity the search relies on would be lost.
const withKeptRows = <TStatement extends BudgetedSqlStatement>(
  entry: BudgetedSqlStatementEntry<TStatement>,
  keptRows: BudgetedSqlStatement["rows"],
): TStatement => (
  entry.isMutating
    ? {
      ...entry.statement,
      rows: keptRows,
      returnedRowCount: keptRows.length,
      truncated: true,
    } as TStatement
    : {
      ...entry.statement,
      rows: keptRows,
      rowCount: keptRows.length,
      returnedRowCount: keptRows.length,
      truncated: true,
    } as TStatement
);

// Rows are kept in statement order, so the caller can read the rest with OFFSET.
// A statement that keeps all of its rows is returned untouched, so a mutation
// that returned none still reports the rows it affected in rowCount.
const keepRowPrefix = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
  keptRowCount: number,
): ReadonlyArray<TStatement> => {
  let remainingRows = keptRowCount;
  return entries.map((entry) => {
    const rows = entry.statement.rows.slice(0, remainingRows);
    remainingRows -= rows.length;
    return rows.length === entry.statement.rows.length
      ? entry.statement
      : withKeptRows(entry, rows);
  });
};

const countRows = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
): number => entries.reduce((total, entry) => total + entry.statement.rows.length, 0);

/**
 * Largest row prefix the halving search measures as fitting MAX_SQL_RESULT_CHARS.
 *
 * measurePayloadChars serializes the object the caller actually emits, so the
 * budget covers that envelope instead of the statements alone. Under the
 * premise above payload size strictly grows with the kept row count: an added
 * row costs at least its own JSON and a comma, and the truncated flip from true
 * to false costs one character more. So the halving search returns the maximal
 * fitting prefix, and every candidate it returns was measured under the budget;
 * when no prefix fits, the fallback below ships over budget instead.
 */
export const applySqlResultCharBudget = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
  measurePayloadChars: (candidate: ReadonlyArray<TStatement>) => number,
): ReadonlyArray<TStatement> => {
  const statements = entries.map((entry) => entry.statement);
  if (measurePayloadChars(statements) <= MAX_SQL_RESULT_CHARS) {
    return statements;
  }

  let lowestRowCount = 0;
  // The full result was just measured and did not fit, so the search starts one
  // row below it.
  let highestRowCount = countRows(entries) - 1;
  let fitting: ReadonlyArray<TStatement> | null = null;
  while (lowestRowCount <= highestRowCount) {
    const candidateRowCount = Math.floor((lowestRowCount + highestRowCount) / 2);
    const candidate = keepRowPrefix(entries, candidateRowCount);
    if (measurePayloadChars(candidate) <= MAX_SQL_RESULT_CHARS) {
      fitting = candidate;
      lowestRowCount = candidateRowCount + 1;
    } else {
      highestRowCount = candidateRowCount - 1;
    }
  }

  // Rows are the only thing this budget can shed, so a payload whose statement
  // text alone is over budget ships row-less rather than failing a read that
  // already ran.
  return fitting ?? keepRowPrefix(entries, 0);
};
