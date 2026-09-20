import {
  executeValidatedExpenseSqlWithinDeadline,
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  SqlPolicyError,
  validateExpenseSql,
  validateReadOnlyExpenseSql,
  type AllowedRelationName,
  type RestrictedSqlResultRow,
  type SqlExecutionDeadline,
  type ValidatedExpenseSql,
  type ValidatedReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { SqlTransactionOutcomeUnknownError } from "../dbDeadline.js";
import { log, type SqlResultOverBudgetOutcome } from "../logger.js";
import type { MachineApiDependencies, PgError, TrustedIdentityContext, WorkspaceSummary } from "./types.js";
import { getWorkspaceBeforeDeadline } from "./workspaceService.js";

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);
// PostgreSQL cancelled a statement at the per-command statement_timeout derived
// from the deadline still left. The total deadline is only checked between
// commands, so one slow statement expires it this way rather than through
// SqlExecutionDeadlineError. Class 57 is not a USER_SQL_ERROR_CLASS, so without
// this check the cancel would be answered as an unclassified infrastructure
// fault.
//
// PostgreSQL also raises 57014 for an operator pg_cancel_backend, and that is
// deliberately not distinguished. Both cancels abort and roll back the
// transaction, so the caller-visible facts are identical; the only thing an
// operator cancel makes slightly off is the "send less work" advice, which is
// harmless for a hand cancel an operator is already watching. Telling them
// apart would mean matching the localized message text ("canceling statement
// due to statement timeout" against "due to user request"), which lc_messages
// can translate, so the test would be a guess dressed as a check.
const STATEMENT_TIMEOUT_ERROR_CODE = "57014";
const DEFAULT_USER_SQL_EXECUTION_MESSAGE = "The SQL statement could not be executed";
const AMBIGUOUS_SQL_MUTATION_OUTCOME_MESSAGE = "The SQL mutation transaction outcome is unknown";
const WRITE_COMMITTED_NOTE = "The write committed and must not be repeated.";
const ROWS_OMITTED_NOTE = `The response exceeded the ${String(MAX_SQL_RESULT_CHARS)} character result budget, so the rows it carried were dropped.`;
// Only rows that still exist can be read back, and only as they stand now, so the
// recovery sentence promises a fresh read rather than the values that were dropped.
const OMITTED_ROWS_READABLE_NOTE = "Run a follow-up SELECT with a narrow LIMIT to read the current rows an INSERT or an UPDATE left in place, or to re-run a co-located SELECT; it reads those rows as they stand now, not the values this response would have carried.";
// rowCount on a row-carrying DELETE is the rows this response would have shipped,
// capped by the row budget, so only totalRowCount records what was removed.
const OMITTED_DELETED_ROWS_NOTE = "The rows a DELETE returned no longer exist, so no follow-up SELECT can recover them; totalRowCount is the record of how many rows it removed, while rowCount is only the rows this response would have carried.";
const NO_ROWS_RETURNED_NOTE = "It returned no rows, so no row data is missing from this response.";
// PostgreSQL command tag of the one mutation whose returned rows are unrecoverable.
const DELETE_COMMAND_TAG = "DELETE";
// The write shrink drops referencedRelations before it touches the echo, so the
// echo survives whole on the first shrunk step; only referencedRelations is always gone.
const RESPONSE_SHRUNK_NOTE = "referencedRelations was dropped, and the echoed sql may be cut to a prefix or replaced by sqlOmitted, so the response fits the budget.";
// One text per stage, never one per kept row count: the read shrink binary-searches
// that count and the search is valid only while the candidate size is monotone in
// it, so these strings must not vary with the rows a candidate keeps. The statement
// count and the pre-shrink returned row total are both fixed before the search
// starts, so selecting the remedies by them is safe.
const READ_RESULT_SHRUNK_NOTE = `This SQL result was shrunk to fit the ${String(MAX_SQL_RESULT_CHARS)} character result budget; returnedRowCount against an unchanged totalRowCount and truncated report exactly what it carries.`;
// Only a statement that returned rows can have an oversized first row to page past,
// so this form is selected on the pre-shrink returned row total, not on what a
// candidate kept.
const SINGLE_STATEMENT_READ_SHRUNK_REMEDIES = "Select fewer or shorter columns first: when returnedRowCount is 0 the first row alone is over the budget, so a lower LIMIT cannot help, but an OFFSET page that skips past that row can still return data when the statement orders by a unique column such as ledger_entries.entry_id. Once rows come back, lower LIMIT or read the remaining rows with OFFSET under that same unique ORDER BY; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip.";
// The statement returned nothing, so there is no oversized row and no page to skip
// to: its own echoed text and the fixed per-statement fields are the whole payload.
const SINGLE_STATEMENT_ZERO_ROW_READ_SHRUNK_REMEDIES = "The statement returned no rows, so no row data is missing from this response and neither a lower LIMIT nor an OFFSET page can change it: its own echoed text and fixed per-statement fields are what exceeded the budget, so shorten the statement text and select fewer columns.";
// A script spends one shared row budget in statement order, so a later statement can
// report zero rows purely because an earlier one used the budget up. Re-running the
// same script with an OFFSET would hit the same distribution and return zero again.
const SCRIPT_READ_SHRUNK_REMEDIES = "The statements share one row budget spent in statement order, so a returnedRowCount of 0 usually means an earlier statement used that budget up rather than that a single row is over it: send fewer statements per request, and lower LIMIT on the earlier statements. Then select fewer or shorter columns, and read the remaining rows with OFFSET when the statement orders by a unique column such as ledger_entries.entry_id; a non-unique ORDER BY leaves tied rows in an arbitrary order that OFFSET can repeat or skip.";
// One statement has nothing to send fewer of, so the two forms name the remedy that
// exists on each: shortening the statement itself, or sending a shorter script.
const SINGLE_STATEMENT_READ_RESPONSE_SHRUNK_NOTE = "referencedRelations was dropped, and the echoed sql may be cut to a prefix, so the rows and their counts fit the budget; shorten the statement text and select fewer columns to keep them.";
const SCRIPT_READ_RESPONSE_SHRUNK_NOTE = "referencedRelations was dropped, and the echoed sql may be cut to a prefix, so the rows and their counts fit the budget; send fewer statements per request to keep them.";

// Every input is fixed before the row search, so this text is one constant per
// stage; the search only ever picks how many rows the stage keeps.
const buildReadShrunkInstructions = (
  statementCount: number,
  returnedRowTotal: number,
  responseShrunk: boolean,
): string => {
  const isScript = statementCount > 1;
  const singleStatementRemedies = returnedRowTotal > 0
    ? SINGLE_STATEMENT_READ_SHRUNK_REMEDIES
    : SINGLE_STATEMENT_ZERO_ROW_READ_SHRUNK_REMEDIES;
  const responseShrunkNote = isScript
    ? SCRIPT_READ_RESPONSE_SHRUNK_NOTE
    : SINGLE_STATEMENT_READ_RESPONSE_SHRUNK_NOTE;
  return [
    READ_RESULT_SHRUNK_NOTE,
    isScript ? SCRIPT_READ_SHRUNK_REMEDIES : singleStatementRemedies,
    ...(responseShrunk ? [responseShrunkNote] : []),
  ].join(" ");
};

// Every result echoes back SQL the caller already holds, and one script may carry
// up to MAX_SQL_SCRIPT_LENGTH characters of it. When dropping rows and
// referencedRelations is not enough, the echo is cut to this prefix so the
// response still identifies each statement without carrying the whole batch back.
const SHRUNK_SQL_ECHO_CHARS = 200;

// The marker costs more characters than a short tail saves, so the original is
// kept whenever the marked-up form is not shorter: truncating an echo must never
// grow it, or the last shrink stage would stop being the smallest one.
const truncateEchoedSql = (sql: string): string => {
  const truncated = `${sql.slice(0, SHRUNK_SQL_ECHO_CHARS)} [echoed SQL truncated to ${String(SHRUNK_SQL_ECHO_CHARS)} of ${String(sql.length)} characters to fit the result budget]`;
  return truncated.length < sql.length ? truncated : sql;
};

type SqlResultStatement = Readonly<{
  sql: string;
  command: string;
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  // Shed by a shrink stage, so a shrunk statement omits it.
  referencedRelations?: ReadonlyArray<AllowedRelationName>;
}>;

type SqlResultPayload = Readonly<{
  statements: ReadonlyArray<SqlResultStatement>;
  workspace: WorkspaceSummary;
  limits: Readonly<{
    maxRows: number;
    maxResultChars: number;
    statementTimeoutMs: number;
  }>;
}>;

type SqlResultBody = Readonly<Record<string, unknown>>;

type SqlResultShrinkReport = Readonly<{
  rowsOmitted?: boolean;
  responseShrunk?: boolean;
  resultSizeInstructions: string;
}>;

type ShrunkWriteResult = Readonly<{
  body: SqlResultBody;
  outcome: Extract<SqlResultOverBudgetOutcome, "write_rows_omitted" | "write_response_shrunk">;
}>;

const fitsResultBudget = (payload: SqlResultBody): boolean =>
  JSON.stringify(payload).length <= MAX_SQL_RESULT_CHARS;

// No shrink stage drops a row, so this total is the same before and inside every
// stage: it is the pre-shrink number of rows the execution actually returned.
const countPayloadRows = (payload: SqlResultPayload): number =>
  payload.statements.reduce((total, statement) => total + statement.rows.length, 0);

// Which kinds of dropped rows the response carried, so the remediation text
// promises recovery only for rows a follow-up SELECT can still reach.
type OmittedWriteRowKinds = Readonly<{
  readable: boolean;
  deleted: boolean;
}>;

// Every shrink signal is emitted from evidence: rowsOmitted only when rows were
// actually dropped, responseShrunk only when the shrink reached past them.
const buildWriteShrinkReport = (
  omittedRows: OmittedWriteRowKinds,
  responseShrunk: boolean,
): SqlResultShrinkReport => {
  const rowsOmitted = omittedRows.readable || omittedRows.deleted;
  return {
    ...(rowsOmitted ? { rowsOmitted: true } : {}),
    ...(responseShrunk ? { responseShrunk: true } : {}),
    resultSizeInstructions: [
      WRITE_COMMITTED_NOTE,
      ...(rowsOmitted
        ? [
          ROWS_OMITTED_NOTE,
          ...(omittedRows.readable ? [OMITTED_ROWS_READABLE_NOTE] : []),
          ...(omittedRows.deleted ? [OMITTED_DELETED_ROWS_NOTE] : []),
        ]
        : [NO_ROWS_RETURNED_NOTE]),
      ...(responseShrunk ? [RESPONSE_SHRUNK_NOTE] : []),
    ].join(" "),
  };
};

// The legacy /v1/sql route accepts a script of up to MAX_SQL_STATEMENTS mixed
// statements, so a shrink follows each statement's own contract: a committed
// mutation keeps reporting the rows it affected, while a read reports rowCount
// as the rows it actually shipped and flags truncated once a row is dropped.
const shrinkStatementToRows = (
  statement: SqlResultStatement,
  isMutating: boolean,
  keptRows: ReadonlyArray<RestrictedSqlResultRow>,
): SqlResultStatement => (
  isMutating
    ? { ...statement, rows: keptRows, returnedRowCount: keptRows.length }
    : {
      ...statement,
      rows: keptRows,
      rowCount: keptRows.length,
      returnedRowCount: keptRows.length,
      truncated: statement.truncated || keptRows.length < statement.rows.length,
    }
);

// Keeps the first keptRowCount rows in statement order, so the caller can read
// the rest with OFFSET, and reports the drop through the three fields the agent
// guide already names: returnedRowCount, an unchanged totalRowCount, truncated.
const buildReadResultWithinRowBudget = (
  payload: SqlResultPayload,
  keptRowCount: number,
  responseShrunk: boolean,
  resultSizeInstructions: string,
): SqlResultBody => {
  let remainingRows = keptRowCount;
  const statements = payload.statements.map((statement) => {
    const rows = statement.rows.slice(0, remainingRows);
    remainingRows -= rows.length;
    return shrinkStatementToRows(statement, false, rows);
  });

  return {
    ...payload,
    statements,
    ...(responseShrunk ? { responseShrunk: true } : {}),
    resultSizeInstructions,
  };
};

// Every field a statement keeps once referencedRelations is gone, enumerated
// rather than spread so that referencedRelations cannot survive by accident, and
// so that a field added to SqlResultStatement later has to be classified as
// sheddable or kept here.
const withoutStatementReferencedRelations = (statement: SqlResultStatement): SqlResultStatement => ({
  sql: statement.sql,
  command: statement.command,
  rows: statement.rows,
  rowCount: statement.rowCount,
  returnedRowCount: statement.returnedRowCount,
  totalRowCount: statement.totalRowCount,
  truncated: statement.truncated,
});

// It only names the relations of SQL the caller wrote, so it is the first thing
// a read sheds once dropping rows is not enough.
const withoutReferencedRelations = (payload: SqlResultPayload): SqlResultPayload => ({
  ...payload,
  statements: payload.statements.map(withoutStatementReferencedRelations),
});

// The caller sent the SQL, so the echo is the last thing worth carrying back.
const withTruncatedEchoedSql = (payload: SqlResultPayload): SqlResultPayload => ({
  ...payload,
  statements: payload.statements.map((statement) => ({
    ...statement,
    sql: truncateEchoedSql(statement.sql),
  })),
});

// Ordered read shrink stages, mirroring the committed-write shrink. Each stage
// rewrites the whole payload before the row search runs over it, never inside
// the search: folding a size-conditional rewrite into the candidate builder
// would make the candidate size non-monotone in the kept row count and silently
// corrupt the binary step.
type ReadShrinkStage = Readonly<{
  build: (payload: SqlResultPayload) => SqlResultPayload;
  responseShrunk: boolean;
}>;

// The smallest payload the read shrink can build, so it stays last in
// READ_SHRINK_STAGES and its zero-row candidate is the residual to report when
// every stage fails. When no echo is long enough to be worth cutting it equals
// the stage before it, which costs one redundant search and never a larger result.
const SMALLEST_READ_SHRINK_STAGE: ReadShrinkStage = {
  build: (payload) => withTruncatedEchoedSql(withoutReferencedRelations(payload)),
  responseShrunk: true,
};

const READ_SHRINK_STAGES: ReadonlyArray<ReadShrinkStage> = [
  { build: (payload) => payload, responseShrunk: false },
  { build: withoutReferencedRelations, responseShrunk: true },
  SMALLEST_READ_SHRINK_STAGE,
];

type FittingReadResult = Readonly<{ fits: true; body: SqlResultBody; keptRowCount: number }>;

type BoundedReadResult =
  | FittingReadResult
  | Readonly<{
    fits: false;
    smallestResultChars: number;
    statementCount: number;
    // How many echoes the smallest stage actually cut, which is not always all of
    // them: truncateEchoedSql keeps an echo the marker would not shorten.
    truncatedEchoCount: number;
  }>;

// Binary search for the largest row prefix that fits within one stage. It is
// valid because the candidate size is monotone in keptRowCount: every field this
// builder rewrites grows or stays equal as rows are added, and the stage itself
// is already fixed before the search starts.
const findLargestFittingRowPrefix = (
  payload: SqlResultPayload,
  responseShrunk: boolean,
): FittingReadResult | null => {
  const returnedRowCount = countPayloadRows(payload);
  // Built once, here, from inputs that are all fixed before the first candidate:
  // an instruction text that varied with the kept rows would break the search.
  const resultSizeInstructions = buildReadShrunkInstructions(
    payload.statements.length,
    returnedRowCount,
    responseShrunk,
  );
  let lowestRowCount = 0;
  let highestRowCount = returnedRowCount;
  let fitting: FittingReadResult | null = null;
  while (lowestRowCount <= highestRowCount) {
    const candidateRowCount = Math.floor((lowestRowCount + highestRowCount) / 2);
    const candidate = buildReadResultWithinRowBudget(
      payload,
      candidateRowCount,
      responseShrunk,
      resultSizeInstructions,
    );
    if (fitsResultBudget(candidate)) {
      fitting = { fits: true, body: candidate, keptRowCount: candidateRowCount };
      lowestRowCount = candidateRowCount + 1;
    } else {
      highestRowCount = candidateRowCount - 1;
    }
  }

  return fitting;
};

// Nothing was committed, so a read may degrade: it sheds rows, then
// referencedRelations, then the echoed statement text, keeping the largest row
// prefix each stage can afford. Only a script whose bare per-statement echo and
// counts are over budget on their own survives every stage.
//
// A stage is accepted only once it ships data. A zero-row prefix technically
// fits, so the unshrunk stage could otherwise spend the whole answer on echoing
// SQL the caller already holds while a later stage, which cuts that echo, would
// have returned rows. Keeping every available row is accepted at once, which
// also short-circuits a read that returned no rows at its first fitting stage,
// keeping whatever that stage still carries; when no stage ships a row, the
// earliest row-less fit is returned instead of a rejection.
const buildReadResultWithinBudget = (
  payload: SqlResultPayload,
): BoundedReadResult => {
  // Fixed before the first stage: no shrink stage adds or drops a row.
  const availableRowCount = countPayloadRows(payload);
  let rowlessFit: FittingReadResult | null = null;
  for (const stage of READ_SHRINK_STAGES) {
    const staged = stage.build(payload);
    const fitting = findLargestFittingRowPrefix(staged, stage.responseShrunk);
    if (fitting !== null) {
      if (fitting.keptRowCount > 0 || fitting.keptRowCount === availableRowCount) {
        return fitting;
      }
      if (rowlessFit === null) {
        rowlessFit = fitting;
      }
    }
  }

  if (rowlessFit !== null) {
    return rowlessFit;
  }

  // Every stage failed, so the payload that actually failed is the zero-row
  // candidate of the smallest stage, not the one that carried every row.
  const smallestPayload = SMALLEST_READ_SHRINK_STAGE.build(payload);
  const smallestResult = buildReadResultWithinRowBudget(
    smallestPayload,
    0,
    SMALLEST_READ_SHRINK_STAGE.responseShrunk,
    buildReadShrunkInstructions(
      payload.statements.length,
      countPayloadRows(payload),
      SMALLEST_READ_SHRINK_STAGE.responseShrunk,
    ),
  );

  return {
    fits: false,
    smallestResultChars: JSON.stringify(smallestResult).length,
    statementCount: payload.statements.length,
    truncatedEchoCount: smallestPayload.statements.filter(
      (statement, index) => statement.sql !== payload.statements[index]?.sql,
    ).length,
  };
};

// Statements short enough that the truncation marker would not shorten them keep
// their echo, so the message claims a cut only for the echoes that took one; with
// none cut, shortening the statements is still an open remedy the message names.
const buildEchoShrinkClause = (statementCount: number, truncatedEchoCount: number): string => {
  if (truncatedEchoCount === 0) {
    return "";
  }
  const scope = truncatedEchoCount === statementCount
    ? `all ${String(statementCount)}`
    : `${String(truncatedEchoCount)} of ${String(statementCount)}`;
  return `, and ${scope} echoed statements cut to a ${String(SHRUNK_SQL_ECHO_CHARS)} character prefix`;
};

// Reachable only after every row, every referencedRelations list, and all but a
// prefix of every echo long enough to be worth cutting is gone, so what is left
// is the fixed per-statement cost of the script itself. Fewer rows cannot clear
// it, and splitting the work into more batched statements makes it worse.
const buildResultTooLargeError = (
  smallestResultChars: number,
  statementCount: number,
  truncatedEchoCount: number,
): SqlPolicyError =>
  new SqlPolicyError(
    "sql_result_too_large",
    `The SQL result is ${String(smallestResultChars)} characters with every row dropped, referencedRelations removed${buildEchoShrinkClause(statementCount, truncatedEchoCount)}, and still exceeds the ${String(MAX_SQL_RESULT_CHARS)} character result budget; send fewer statements per request, and shorten any statement whose own text is long`,
  );

// The mutation transaction already committed, so failing here would push the
// caller toward repeating a write that already applied. Every step below shrinks
// the response and always returns.
const buildCommittedWriteResultWithinBudget = (
  payload: SqlResultPayload,
  mutatingStatements: ReadonlyArray<boolean>,
): ShrunkWriteResult => {
  const isMutatingStatement = (index: number): boolean => {
    const isMutating = mutatingStatements[index];
    if (isMutating === undefined) {
      throw new TypeError(
        `SQL result statement ${String(index + 1)} has no recorded mutation kind`,
      );
    }
    return isMutating;
  };
  const statementsWithRows = payload.statements.filter((statement) => statement.rows.length > 0);
  const omittedRows: OmittedWriteRowKinds = {
    readable: statementsWithRows.some((statement) => statement.command !== DELETE_COMMAND_TAG),
    deleted: statementsWithRows.some((statement) => statement.command === DELETE_COMMAND_TAG),
  };
  // A script picks this path as soon as one statement mutates, so a SELECT next
  // to it keeps the read contract instead of inheriting write field semantics.
  const withoutRows = {
    ...payload,
    statements: payload.statements.map((statement, index) => shrinkStatementToRows(
      statement,
      isMutatingStatement(index),
      [],
    )),
    ...buildWriteShrinkReport(omittedRows, false),
  };
  if (fitsResultBudget(withoutRows)) {
    return { body: withoutRows, outcome: "write_rows_omitted" };
  }

  // Rows are already gone, so the echoed statement and its referencedRelations are
  // what remains over budget. referencedRelations goes first, mirroring
  // READ_SHRINK_STAGES: the echo is the only thing tying each count in this
  // response back to the statement that produced it. Every count and the
  // instructions must survive both steps.
  const withoutRelations = {
    ...withoutRows,
    statements: withoutRows.statements.map(withoutStatementReferencedRelations),
    ...buildWriteShrinkReport(omittedRows, true),
  };
  if (fitsResultBudget(withoutRelations)) {
    return { body: withoutRelations, outcome: "write_response_shrunk" };
  }

  // Dropping referencedRelations was not enough, so the echo the caller already
  // holds is cut to a prefix. The spread is safe here only because the step above
  // already rebuilt every statement field by field.
  const withTruncatedSql = {
    ...withoutRelations,
    statements: withoutRelations.statements.map((statement) => ({
      ...statement,
      sql: truncateEchoedSql(statement.sql),
    })),
  };
  if (fitsResultBudget(withTruncatedSql)) {
    return { body: withTruncatedSql, outcome: "write_response_shrunk" };
  }

  // JSON escaping can still blow a prefixed echo past the budget across a full
  // MAX_SQL_STATEMENTS script, so the last step drops the echo entirely and
  // leaves a fixed-size set of counts per statement.
  return {
    body: {
      ...withTruncatedSql,
      statements: withTruncatedSql.statements.map((statement) => ({
        sqlOmitted: true,
        command: statement.command,
        rows: [],
        rowCount: statement.rowCount,
        returnedRowCount: 0,
        totalRowCount: statement.totalRowCount,
        truncated: statement.truncated,
      })),
    },
    outcome: "write_response_shrunk",
  };
};

export class UserSqlExecutionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class AmbiguousSqlMutationOutcomeError extends Error {
  constructor(cause: unknown) {
    super(AMBIGUOUS_SQL_MUTATION_OUTCOME_MESSAGE, { cause });
  }
}

const isSafeUserSqlDatabaseError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const pgError = error as PgError;
  if (typeof pgError.code !== "string" || pgError.code.length < 2) {
    return false;
  }

  return USER_SQL_ERROR_CLASSES.has(pgError.code.slice(0, 2));
};

const getDatabaseErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return DEFAULT_USER_SQL_EXECUTION_MESSAGE;
};

const throwUserSqlExecutionError = (error: unknown): never => {
  if (!isSafeUserSqlDatabaseError(error)) {
    throw error;
  }
  throw new UserSqlExecutionError(getDatabaseErrorMessage(error));
};

export const isUserSqlExecutionError = (error: unknown): error is UserSqlExecutionError =>
  error instanceof UserSqlExecutionError;

export const isSqlStatementTimeoutError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && (error as PgError).code === STATEMENT_TIMEOUT_ERROR_CODE;

export const isAmbiguousSqlMutationOutcomeError = (
  error: unknown,
): error is AmbiguousSqlMutationOutcomeError =>
  error instanceof AmbiguousSqlMutationOutcomeError;

export const getUserSqlExecutionMessage = (error: unknown): string => {
  if (error instanceof UserSqlExecutionError && error.message !== "") {
    return error.message;
  }
  return DEFAULT_USER_SQL_EXECUTION_MESSAGE;
};

const isSchemaExplorationAttempt = (message: string): boolean =>
  /information_schema|pg_catalog|pg_/iu.test(message);

type MachineApiWorkspaceGetter = (
  dependencies: MachineApiDependencies,
  identity: TrustedIdentityContext["identity"],
  workspaceId: string,
  deadline: SqlExecutionDeadline,
) => Promise<WorkspaceSummary | null>;

export type ExistingWorkspaceGetter = (
  identity: TrustedIdentityContext["identity"],
  workspaceId: string,
  deadline: SqlExecutionDeadline,
) => Promise<WorkspaceSummary | null>;

type RestrictedContextRunner = MachineApiDependencies["withRestrictedTrustedIdentityContext"];

export const getSqlPolicyInstructions = (
  error: SqlPolicyError,
  apiBaseUrl: string,
): string => {
  if (error.code === "relation_not_allowed") {
    if (isSchemaExplorationAttempt(error.message)) {
      return `System catalogs are not queryable via restricted SQL. Use ${apiBaseUrl}/schema to inspect allowed relations, columns, and any agent hints, then query only those relations through ${apiBaseUrl}/sql/query. Example: SELECT * FROM accounts LIMIT 0.`;
    }

    return `Relation is not exposed by policy. Use ${apiBaseUrl}/schema to see allowed relations, columns, and any agent hints, then retry. Workspace context must be set via /workspaces/{workspaceId}/select or X-Workspace-Id.`;
  }

  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, budget_adjustments, workspace_settings, or account_metadata.`;
  }

  if (error.code === "recursive_cte_search_cycle_not_allowed") {
    return "Recursive CTE SEARCH and CYCLE clauses are not supported in restricted SQL. Rewrite the CTE without those clauses.";
  }

  if (error.code === "unsupported_statement") {
    return "Send exactly one SELECT or WITH...SELECT statement to /sql/query, or exactly one approved INSERT, UPDATE, or DELETE mutation to /sql/execute. Legacy /sql accepts atomic multi-statement scripts. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "single_statement_required") {
    return "Send exactly one read-only statement to /sql/query or exactly one approved mutation to /sql/execute. Use legacy /sql only when an atomic multi-statement script is required.";
  }

  if (error.code === "sql_script_too_long" || error.code === "too_many_sql_statements") {
    return error.message;
  }

  if (
    error.code === "mutation_statement_row_limit_exceeded"
    || error.code === "mutation_request_row_limit_exceeded"
  ) {
    return `${error.message}. Narrow the mutation or split it into sequential requests of at most ${MAX_SQL_MUTATION_ROWS} affected rows each.`;
  }

  if (error.code === "sql_result_too_large") {
    return `${error.message}. Dropping rows cannot clear this, so a lower LIMIT or an OFFSET page returns the same error; split the script and send fewer statements per request, or send one statement at a time to ${apiBaseUrl}/sql/query.`;
  }

  if (error.code === "read_only_sql_required") {
    return "Use /sql/query for exactly one SELECT or WITH...SELECT statement without data-modifying CTEs. Send one approved write statement to /sql/execute.";
  }

  if (error.code === "mutation_sql_required") {
    return `Use ${apiBaseUrl}/sql/query for SELECT and WITH...SELECT. ${apiBaseUrl}/sql/execute accepts exactly one approved INSERT, UPDATE, or DELETE mutation.`;
  }

  if (error.code === "on_conflict_not_allowed") {
    return "ON CONFLICT is not supported in restricted SQL. Use explicit SELECT first, then INSERT or UPDATE as separate steps.";
  }

  if (error.code === "unsupported_sql_construct") {
    return "The error message names the unsupported construct and what to do instead. Follow that guidance.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "function_calls_not_allowed") {
    return "Restricted SQL allows a fixed set of pure aggregate, date, text, cast, and window functions, and the error message lists them by name. Query only the published tables and views directly, and prefer ILIKE for case-insensitive text search.";
  }

  if (error.code === "sql_comments_not_allowed") {
    return "Remove SQL comments (`--` and `/* ... */`) and retry.";
  }

  if (error.code === "quoted_identifiers_not_allowed") {
    return "Quoted identifiers are not allowed. Use unquoted lower_snake_case relation and column names.";
  }

  if (error.code === "dollar_quoted_strings_not_allowed") {
    return "Dollar-quoted strings are not allowed. Use regular single-quoted literals.";
  }

  if (error.code === "escape_string_literals_not_allowed") {
    return "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
};

const executeSqlWithWorkspaceGetter = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  executionDeadline: SqlExecutionDeadline,
  workspaceGetter: ExistingWorkspaceGetter,
  runInRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const workspace = await workspaceGetter(
    authenticated.identity,
    workspaceId,
    executionDeadline,
  );
  if (workspace === null) {
    return null;
  }

  const mutatingSql: ReadonlySet<string> = new Set(
    validated.statements
      .filter((statement) => statement.isMutating)
      .map((statement) => statement.sql),
  );
  let mutationExecutionStarted = false;
  let result: Awaited<ReturnType<typeof executeValidatedExpenseSqlWithinDeadline>>;
  try {
    result = await runInRestrictedContext(
      authenticated.identity,
      workspaceId,
      executionDeadline,
      async (queryFn) => {
        const executed = await executeValidatedExpenseSqlWithinDeadline(
          validated,
          executionDeadline,
          async (request, remainingStatementTimeoutMs) => {
            try {
              const queryResult = await queryFn(
                request.sql,
                request.params,
                remainingStatementTimeoutMs,
                () => {
                  if (mutatingSql.has(request.sql)) {
                    mutationExecutionStarted = true;
                  }
                },
              );
              return {
                command: queryResult.command,
                rows: queryResult.rows as ReadonlyArray<Readonly<Record<string, unknown>>>,
                rowCount: queryResult.rowCount,
              };
            } catch (error) {
              return throwUserSqlExecutionError(error);
            }
          },
        );
        return executed;
      },
    );
  } catch (error) {
    if (error instanceof SqlTransactionOutcomeUnknownError) {
      if (!mutationExecutionStarted) {
        throw error.originalError;
      }
      throw new AmbiguousSqlMutationOutcomeError(error);
    }
    throw error;
  }

  const payload: SqlResultPayload = {
    statements: result.statements.map((statement) => ({
      sql: statement.sql,
      command: statement.command,
      rows: statement.rows,
      rowCount: statement.rowCount,
      returnedRowCount: statement.returnedRowCount,
      totalRowCount: statement.totalRowCount,
      truncated: statement.truncated,
      referencedRelations: statement.referencedRelations,
    })),
    workspace,
    limits: {
      maxRows: MAX_SQL_ROWS,
      maxResultChars: MAX_SQL_RESULT_CHARS,
      statementTimeoutMs: executionDeadline.timeoutMs,
    },
  };

  // Measured on the payload every machine surface returns, so the MCP tools and
  // the REST routes share one budget; each surface adds only a few hundred
  // characters of envelope around it.
  const resultChars = JSON.stringify(payload).length;
  if (resultChars <= MAX_SQL_RESULT_CHARS) {
    return payload;
  }

  const statementCount = payload.statements.length;
  const logOverBudget = (
    outcome: SqlResultOverBudgetOutcome,
    keptRowCount?: number,
  ): void => {
    log({
      domain: "sql_api",
      action: "sql_result_over_budget",
      outcome,
      resultChars,
      statementCount,
      ...(keptRowCount === undefined ? {} : { keptRowCount }),
    });
  };

  if (result.statements.some((statement) => statement.isMutating)) {
    const written = buildCommittedWriteResultWithinBudget(
      payload,
      result.statements.map((statement) => statement.isMutating),
    );
    logOverBudget(written.outcome);
    return written.body;
  }

  const read = buildReadResultWithinBudget(payload);
  if (!read.fits) {
    logOverBudget("read_rejected");
    throw buildResultTooLargeError(
      read.smallestResultChars,
      read.statementCount,
      read.truncatedEchoCount,
    );
  }

  logOverBudget("read_rows_dropped", read.keptRowCount);
  return read.body;
};

export const runSqlWithWorkspaceGetter = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  sql: string,
  executionDeadline: SqlExecutionDeadline,
  workspaceGetter: MachineApiWorkspaceGetter,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validateExpenseSql(sql),
    executionDeadline,
    (identity, resolvedWorkspaceId, deadline) => workspaceGetter(
      dependencies,
      identity,
      resolvedWorkspaceId,
      deadline,
    ),
    dependencies.withRestrictedTrustedIdentityContext,
  );

export const runReadOnlySqlWithWorkspaceGetter = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  sql: string,
  executionDeadline: SqlExecutionDeadline,
  workspaceGetter: MachineApiWorkspaceGetter,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validateReadOnlyExpenseSql(sql),
    executionDeadline,
    (identity, resolvedWorkspaceId, deadline) => workspaceGetter(
      dependencies,
      identity,
      resolvedWorkspaceId,
      deadline,
    ),
    dependencies.withReadOnlyRestrictedTrustedIdentityContext,
  );

export const runSqlWithServices = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  executionDeadline: SqlExecutionDeadline,
  workspaceGetter: ExistingWorkspaceGetter,
  runInRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    executionDeadline,
    workspaceGetter,
    runInRestrictedContext,
  );

export const runReadOnlySqlWithServices = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedReadOnlyExpenseSql,
  executionDeadline: SqlExecutionDeadline,
  workspaceGetter: ExistingWorkspaceGetter,
  runInReadOnlyRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    executionDeadline,
    workspaceGetter,
    runInReadOnlyRestrictedContext,
  );

export const runSql = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  executionDeadline: SqlExecutionDeadline,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    executionDeadline,
    (identity, resolvedWorkspaceId, deadline) => getWorkspaceBeforeDeadline(
      dependencies,
      identity,
      resolvedWorkspaceId,
      deadline,
    ),
    dependencies.withRestrictedTrustedIdentityContext,
  );

export const runReadOnlySql = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedReadOnlyExpenseSql,
  executionDeadline: SqlExecutionDeadline,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    executionDeadline,
    (identity, resolvedWorkspaceId, deadline) => getWorkspaceBeforeDeadline(
      dependencies,
      identity,
      resolvedWorkspaceId,
      deadline,
    ),
    dependencies.withReadOnlyRestrictedTrustedIdentityContext,
  );
