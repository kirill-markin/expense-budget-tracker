import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import {
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  validateExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import {
  AgentSqlMutationOutcomeUnknownError,
  executeAgentSqlWithDependencies,
  type AgentSqlDependencies,
} from "@/server/agent/sql";
import { DbTransactionOutcomeUnknownError, type QueryFn } from "@/server/db/contextRunner";
import type { UserIdentity } from "@/server/users";
import type { WorkspaceSummary } from "@/server/workspaces";

const AUTHENTICATED: AgentAuthenticatedRequest = {
  transport: "api_key",
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
  connectionId: "connection-1",
  label: "desktop",
  createdAt: "2026-04-01T00:00:00.000Z",
  lastUsedAt: null,
};

const OVERSIZED_ROW_COUNT = 100;
const FITTING_ROW_COUNT = 5;
const MUTATION_ROW_COUNT = 60;
const OVERSIZED_SQL = "SELECT entry_id, note FROM ledger_entries";
const FITTING_SQL = `SELECT entry_id, note FROM ledger_entries LIMIT ${String(FITTING_ROW_COUNT)}`;
const MUTATION_SQL = "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1' RETURNING entry_id, note";

type RecordedCommand = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type RestrictedContextCall = Readonly<{
  method: "withReadOnlyRestrictedTrustedIdentityContext" | "withRestrictedTrustedIdentityContext";
  userId: string;
  workspaceId: string;
  statementTimeoutMs: number;
}>;

const createQueryResult = (
  command: string,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): PgQueryResult => ({
  command,
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

// 600-char notes, the row width that makes an ordinary 100-row read oversized.
const createRows = (rowCount: number): ReadonlyArray<Readonly<Record<string, string>>> =>
  Array.from({ length: rowCount }, (_value, index) => ({
    entry_id: `entry-${String(index)}`,
    note: "н".repeat(600),
  }));

// The restricted read path reads every SELECT through a cursor, so the fake
// answers DECLARE, FETCH, and MOVE the way PostgreSQL does. CLOSE and the
// per-command statement_timeout get a result nothing reads.
const createCursorQueryFn = (): QueryFn => {
  let cursorRows: ReadonlyArray<Readonly<Record<string, string>>> = [];
  return async (sql): Promise<PgQueryResult> => {
    if (sql.startsWith("DELETE ")) {
      return createQueryResult("DELETE", createRows(MUTATION_ROW_COUNT));
    }
    if (sql.startsWith("DECLARE ")) {
      cursorRows = createRows(
        sql.includes(`LIMIT ${String(FITTING_ROW_COUNT)}`) ? FITTING_ROW_COUNT : OVERSIZED_ROW_COUNT,
      );
      return createQueryResult("DECLARE CURSOR", []);
    }
    if (sql.startsWith("FETCH FORWARD ")) {
      return createQueryResult("SELECT", cursorRows);
    }
    if (sql.startsWith("MOVE FORWARD ALL ")) {
      return createQueryResult("MOVE", []);
    }
    return createQueryResult("CLOSE CURSOR", []);
  };
};

// Every command gets an empty result: an empty read's FETCH and MOVE, and a
// zero-row DELETE, are all the executor needs to run a script to completion.
const createRecordingQueryFn = (commands: Array<RecordedCommand>): QueryFn =>
  async (text, params): Promise<PgQueryResult> => {
    commands.push({ text, params });
    return createQueryResult(text.startsWith("DELETE ") ? "DELETE" : "SELECT", []);
  };

// Starts the deadline at 0 and advances one second on every later reading, so
// each command's statement_timeout shows the budget still left.
const createSteppingClock = (): (() => number) => {
  let nowMs = 0;
  return (): number => {
    const currentMs = nowMs;
    nowMs += 1_000;
    return currentMs;
  };
};

// Both runners hand the callback the same query function and record only which
// one ran; apps/web/src/server/db/facade.test.ts pins the transaction and role
// each of them opens.
const createDependencies = (
  queryFn: QueryFn,
  contextCalls: Array<RestrictedContextCall>,
  now: () => number,
): AgentSqlDependencies => ({
  getWorkspaceForTrustedIdentity: async (): Promise<WorkspaceSummary> => ({
    workspaceId: "workspace-1",
    name: "Personal",
  }),
  withReadOnlyRestrictedTrustedIdentityContext: async <T>(
    identity: UserIdentity,
    workspaceId: string,
    statementTimeoutMs: number,
    callback: (restrictedQueryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    contextCalls.push({
      method: "withReadOnlyRestrictedTrustedIdentityContext",
      userId: identity.userId,
      workspaceId,
      statementTimeoutMs,
    });
    return callback(queryFn);
  },
  withRestrictedTrustedIdentityContext: async <T>(
    identity: UserIdentity,
    workspaceId: string,
    statementTimeoutMs: number,
    callback: (restrictedQueryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    contextCalls.push({
      method: "withRestrictedTrustedIdentityContext",
      userId: identity.userId,
      workspaceId,
      statementTimeoutMs,
    });
    return callback(queryFn);
  },
  now,
});

// Both runners run the script to completion and then fail the way a COMMIT that
// never reported back does.
const createCommitOutcomeUnknownDependencies = (
  queryFn: QueryFn,
  outcomeUnknown: DbTransactionOutcomeUnknownError,
): AgentSqlDependencies => {
  const runAndFail = async <T>(
    _identity: UserIdentity,
    _workspaceId: string,
    _statementTimeoutMs: number,
    callback: (restrictedQueryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    await callback(queryFn);
    throw outcomeUnknown;
  };
  return {
    ...createDependencies(queryFn, [], () => 0),
    withReadOnlyRestrictedTrustedIdentityContext: runAndFail,
    withRestrictedTrustedIdentityContext: runAndFail,
  };
};

const createWorkspaceLookupFailingDependencies = (
  failure: Error,
  contextCalls: Array<RestrictedContextCall>,
): AgentSqlDependencies => ({
  ...createDependencies(createRecordingQueryFn([]), contextCalls, () => 0),
  getWorkspaceForTrustedIdentity: async (): Promise<WorkspaceSummary> => {
    throw failure;
  },
});

const command = (text: string): RecordedCommand => ({ text, params: [] });

const remainingTimeout = (elapsedMs: number): RecordedCommand =>
  command(`SET LOCAL statement_timeout = ${String(SQL_STATEMENT_TIMEOUT_MS - elapsedMs)}`);

const COMMIT_TIMEOUT = command("SET LOCAL statement_timeout = 10000");

test("executeAgentSqlWithDependencies bounds the result in characters and keeps a cut mutation's affected row count", async (): Promise<void> => {
  const dependencies = createDependencies(createCursorQueryFn(), [], () => 0);

  const oversized = await executeAgentSqlWithDependencies(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(OVERSIZED_SQL),
    dependencies,
  );
  const fitting = await executeAgentSqlWithDependencies(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(FITTING_SQL),
    dependencies,
  );
  const mutation = await executeAgentSqlWithDependencies(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(MUTATION_SQL),
    dependencies,
  );

  assert.ok(oversized);
  assert.ok(mutation);
  const cutStatement = oversized.statements[0];
  const mutationStatement = mutation.statements[0];
  assert.ok(cutStatement);
  assert.ok(mutationStatement);

  assert.equal(oversized.limits.maxResultChars, MAX_SQL_RESULT_CHARS);
  assert.ok(JSON.stringify(oversized).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(cutStatement.rows.length > 0);
  assert.ok(cutStatement.rows.length < OVERSIZED_ROW_COUNT);
  assert.equal(cutStatement.rowCount, cutStatement.rows.length);
  assert.equal(cutStatement.returnedRowCount, cutStatement.rows.length);
  assert.equal(cutStatement.totalRowCount, OVERSIZED_ROW_COUNT);
  assert.equal(cutStatement.truncated, true);

  // Pinned whole: relation documentation comes only from GET /api/agent/schema,
  // so a statement carries its execution metadata and nothing else.
  assert.deepEqual(fitting, {
    statements: [{
      sql: FITTING_SQL,
      command: "SELECT",
      rows: createRows(FITTING_ROW_COUNT),
      rowCount: FITTING_ROW_COUNT,
      returnedRowCount: FITTING_ROW_COUNT,
      totalRowCount: FITTING_ROW_COUNT,
      truncated: false,
      referencedRelations: ["ledger_entries"],
    }],
    workspace: {
      workspaceId: "workspace-1",
      name: "Personal",
    },
    limits: {
      maxRows: MAX_SQL_ROWS,
      maxResultChars: MAX_SQL_RESULT_CHARS,
      statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
    },
  });

  assert.ok(JSON.stringify(mutation).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(mutationStatement.rows.length > 0);
  assert.ok(mutationStatement.rows.length < MUTATION_ROW_COUNT);
  // The write committed, so its rowCount keeps naming the rows it affected.
  assert.equal(mutationStatement.rowCount, MUTATION_ROW_COUNT);
  assert.equal(mutationStatement.returnedRowCount, mutationStatement.rows.length);
  assert.equal(mutationStatement.totalRowCount, MUTATION_ROW_COUNT);
  assert.equal(mutationStatement.truncated, true);
});

test("executeAgentSqlWithDependencies runs a script without a mutating statement in the read-only context, bounding every command by the deadline", async (): Promise<void> => {
  const commands: Array<RecordedCommand> = [];
  const contextCalls: Array<RestrictedContextCall> = [];

  await executeAgentSqlWithDependencies(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql("SELECT account_id FROM accounts; SELECT entry_id FROM ledger_entries"),
    createDependencies(createRecordingQueryFn(commands), contextCalls, createSteppingClock()),
  );

  assert.deepEqual(contextCalls, [{
    method: "withReadOnlyRestrictedTrustedIdentityContext",
    userId: "user-1",
    workspaceId: "workspace-1",
    statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
  }]);
  assert.deepEqual(commands, [
    remainingTimeout(1_000),
    command("DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR SELECT account_id FROM accounts"),
    remainingTimeout(2_000),
    command(`FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_1`),
    remainingTimeout(3_000),
    command("MOVE FORWARD ALL FROM api_sql_read_cursor_1"),
    remainingTimeout(4_000),
    command("CLOSE api_sql_read_cursor_1"),
    remainingTimeout(5_000),
    command("DECLARE api_sql_read_cursor_2 NO SCROLL CURSOR FOR SELECT entry_id FROM ledger_entries"),
    remainingTimeout(6_000),
    command(`FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_2`),
    remainingTimeout(7_000),
    command("MOVE FORWARD ALL FROM api_sql_read_cursor_2"),
    remainingTimeout(8_000),
    command("CLOSE api_sql_read_cursor_2"),
    COMMIT_TIMEOUT,
  ]);
});

test("executeAgentSqlWithDependencies keeps a whole script with any mutating statement in the writable executor context", async (): Promise<void> => {
  const commands: Array<RecordedCommand> = [];
  const contextCalls: Array<RestrictedContextCall> = [];

  await executeAgentSqlWithDependencies(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql("SELECT account_id FROM accounts; DELETE FROM ledger_entries WHERE entry_id = 'entry-1'"),
    createDependencies(createRecordingQueryFn(commands), contextCalls, createSteppingClock()),
  );

  assert.deepEqual(contextCalls, [{
    method: "withRestrictedTrustedIdentityContext",
    userId: "user-1",
    workspaceId: "workspace-1",
    statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
  }]);
  assert.deepEqual(commands, [
    remainingTimeout(1_000),
    command("DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR SELECT account_id FROM accounts"),
    remainingTimeout(2_000),
    command(`FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_1`),
    remainingTimeout(3_000),
    command("MOVE FORWARD ALL FROM api_sql_read_cursor_1"),
    remainingTimeout(4_000),
    command("CLOSE api_sql_read_cursor_1"),
    remainingTimeout(5_000),
    command("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'"),
    COMMIT_TIMEOUT,
  ]);
});

test("executeAgentSqlWithDependencies reports an unknown outcome as a mutation only after a mutating statement was issued", async (): Promise<void> => {
  const connectionLost = new Error("Connection terminated unexpectedly");
  const outcomeUnknown = new DbTransactionOutcomeUnknownError("commit", connectionLost, undefined);
  const mutatingScript = "SELECT account_id FROM accounts; DELETE FROM ledger_entries WHERE entry_id = 'entry-1'";

  await assert.rejects(
    () => executeAgentSqlWithDependencies(
      AUTHENTICATED,
      "workspace-1",
      validateExpenseSql(mutatingScript),
      createCommitOutcomeUnknownDependencies(createRecordingQueryFn([]), outcomeUnknown),
    ),
    (error: unknown) => error instanceof AgentSqlMutationOutcomeUnknownError
      && error.message === "The SQL mutation transaction outcome is unknown"
      && error.cause === outcomeUnknown,
  );

  // A script without a mutating statement wrote nothing, so the COMMIT that
  // never reported back stays the connection failure it was.
  await assert.rejects(
    () => executeAgentSqlWithDependencies(
      AUTHENTICATED,
      "workspace-1",
      validateExpenseSql("SELECT account_id FROM accounts"),
      createCommitOutcomeUnknownDependencies(createRecordingQueryFn([]), outcomeUnknown),
    ),
    (error: unknown) => error === connectionLost,
  );

  // The workspace lookup fails before any transaction is opened for the script,
  // so its unknown outcome is never the mutation's: it reaches the caller whole,
  // rather than unwrapped to the failure behind it the way an issued script's
  // unknown outcome is.
  const lookupContextCalls: Array<RestrictedContextCall> = [];
  await assert.rejects(
    () => executeAgentSqlWithDependencies(
      AUTHENTICATED,
      "workspace-1",
      validateExpenseSql(mutatingScript),
      createWorkspaceLookupFailingDependencies(outcomeUnknown, lookupContextCalls),
    ),
    (error: unknown) => error === outcomeUnknown,
  );
  assert.deepEqual(lookupContextCalls, []);
});
