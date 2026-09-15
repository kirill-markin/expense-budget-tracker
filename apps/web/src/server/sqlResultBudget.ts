/**
 * Character budget for the SQL results the web app hands to an agent.
 *
 * Both web surfaces emit one whole result per call: the chat sends it into an
 * OpenAI turn that re-sends it on every later model call of the same turn, and
 * the agent SQL route returns it to an API-key client. Dropping rows is the
 * mechanism every caller gets, and a cut is reported through the fields the
 * machine API already uses: returnedRowCount becomes the rows actually shipped,
 * truncated is set, and totalRowCount keeps naming what the query matched. A
 * caller that also attaches a re-readable field, such as the agent SQL route's
 * per-relation hints, opts into shedding it first through a shrink stage.
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

/**
 * One ordered stage that sheds a whole re-readable field, mirroring
 * READ_SHRINK_STAGES in apps/sql-api/src/machineApi/sqlService.ts: the stage
 * rebuilds every entry before the row search runs over it, so the field is gone
 * from every candidate that search measures. A stage must never react to a
 * candidate's size; a size-conditional rewrite inside the search would make
 * candidate size non-monotone in the kept row count and silently corrupt the
 * binary step.
 */
export type BudgetedSqlShrinkStage<TStatement extends BudgetedSqlStatement> = Readonly<{
  build: (entry: BudgetedSqlStatementEntry<TStatement>) => BudgetedSqlStatementEntry<TStatement>;
  // Reported back on the result, so the caller can tell the agent what is missing
  // from the response and where to read it again.
  shrunk: boolean;
}>;

export type BudgetedSqlResult<TStatement extends BudgetedSqlStatement> = Readonly<{
  statements: ReadonlyArray<TStatement>;
  shrunk: boolean;
}>;

// The payload as the caller built it. It is always the first stage, so a caller
// only names the stages it is willing to shed and the search still runs over the
// whole payload first.
const unshrunkStage = <TStatement extends BudgetedSqlStatement>(
): BudgetedSqlShrinkStage<TStatement> => ({
  build: (entry) => entry,
  shrunk: false,
});

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

const countStatementRows = <TStatement extends BudgetedSqlStatement>(
  statements: ReadonlyArray<TStatement>,
): number => statements.reduce((total, statement) => total + statement.rows.length, 0);

/**
 * Largest row prefix the halving search measures as fitting MAX_SQL_RESULT_CHARS
 * within one already-built stage, or null when not even zero rows fit.
 *
 * measurePayloadChars serializes the object the caller actually emits, so the
 * budget covers that envelope instead of the statements alone. Under the
 * premise above payload size strictly grows with the kept row count: an added
 * row costs at least its own JSON and a comma, and the truncated flip from true
 * to false costs one character more. The stage itself is fixed before the first
 * candidate, so the halving search returns the maximal fitting prefix and every
 * candidate it returns was measured under the budget.
 */
const findLargestFittingRowPrefix = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
  measurePayloadChars: (candidate: ReadonlyArray<TStatement>) => number,
): ReadonlyArray<TStatement> | null => {
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

  return fitting;
};

/**
 * Applies the caller's shrink stages in order, running the whole row search over
 * each one, and reports which stage the returned statements came from.
 *
 * A stage is tried only after the previous one failed to ship data, so a field a
 * stage sheds is dropped only when no row prefix could pay for it, and rows are
 * still the first thing to go. Failing to ship data means either that no prefix
 * fit at all or that the only prefix that fit was empty while the payload had
 * rows to give: a stage whose whole cost is a re-readable field must never buy
 * its own survival with every row of the answer, so a later stage that returns
 * data outranks an earlier one that returns none.
 *
 * When no stage ships a row, the earliest stage that fit row-less is returned,
 * which is the most informative body available and keeps a payload whose
 * statements alone fill the budget on exactly the outcome it had before. When
 * every stage fails, the smallest stage ships over budget row-less rather than
 * failing a read that already ran.
 */
export const applyStagedSqlResultCharBudget = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
  measurePayloadChars: (candidate: ReadonlyArray<TStatement>, shrunk: boolean) => number,
  shrinkStages: ReadonlyArray<BudgetedSqlShrinkStage<TStatement>>,
): BudgetedSqlResult<TStatement> => {
  // Fixed before the first stage, because no stage adds or drops a row: a stage
  // that kept every available row displaced nothing and is accepted at once,
  // which also leaves a payload that returned no rows on its first stage.
  const availableRowCount = countRows(entries);
  let smallestEntries = entries;
  let smallestShrunk = false;
  let rowlessFit: BudgetedSqlResult<TStatement> | null = null;
  for (const stage of [unshrunkStage<TStatement>(), ...shrinkStages]) {
    const staged = entries.map((entry) => stage.build(entry));
    const fitting = findLargestFittingRowPrefix(
      staged,
      (candidate) => measurePayloadChars(candidate, stage.shrunk),
    );
    if (fitting !== null) {
      const keptRowCount = countStatementRows(fitting);
      if (keptRowCount > 0 || keptRowCount === availableRowCount) {
        return { statements: fitting, shrunk: stage.shrunk };
      }
      // Kept as the fallback rather than returned: a later stage may still ship
      // rows, and if none does this earliest row-less fit is what ships.
      if (rowlessFit === null) {
        rowlessFit = { statements: fitting, shrunk: stage.shrunk };
      }
    }
    smallestEntries = staged;
    smallestShrunk = stage.shrunk;
  }

  if (rowlessFit !== null) {
    return rowlessFit;
  }

  // The residual is the zero-row candidate of the smallest stage, not of the one
  // that still carried every sheddable field.
  return { statements: keepRowPrefix(smallestEntries, 0), shrunk: smallestShrunk };
};

/**
 * Row-only budget for a caller whose statements carry nothing sheddable, so a
 * payload whose statement text alone is over budget ships row-less.
 */
export const applySqlResultCharBudget = <TStatement extends BudgetedSqlStatement>(
  entries: ReadonlyArray<BudgetedSqlStatementEntry<TStatement>>,
  measurePayloadChars: (candidate: ReadonlyArray<TStatement>) => number,
): ReadonlyArray<TStatement> =>
  applyStagedSqlResultCharBudget(entries, measurePayloadChars, []).statements;
