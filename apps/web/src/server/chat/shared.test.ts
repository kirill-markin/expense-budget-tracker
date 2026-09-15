import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import {
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import {
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  CHAT_SQL_COMMIT_TIMEOUT_MS,
  execQueryWithDependencies,
  getChatSqlDeadlineMessage,
  getChatSqlPolicyMessage,
  type ChatSqlExecutionContext,
  type ChatSqlTarget,
  type ExecQueryDependencies,
} from "@/server/chat/shared";
import { ChatTurnCancelledError } from "@/server/chat/store";
import type { QueryFn } from "@/server/db/contextRunner";
import type { WorkspaceSummary } from "@/server/workspaces";

const CONTEXT: ChatSqlExecutionContext = {
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
};

// Deliberately not the session's workspace-1: every call below runs against
// another workspace the user is a member of, so the tests show which workspace
// each part of the transaction is bound to.
const TARGET_WORKSPACE: WorkspaceSummary = { workspaceId: "workspace-2", name: "Business" };

const READ_TARGET: ChatSqlTarget = {
  workspace: TARGET_WORKSPACE,
  instructions: SQL_QUERY_TOOL.successInstructions,
};

const WRITE_TARGET: ChatSqlTarget = {
  workspace: TARGET_WORKSPACE,
  instructions: SQL_EXECUTE_TOOL.successInstructions,
};

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

const createAffectedRowsResult = (
  command: string,
  rowCount: number,
): PgQueryResult => ({
  command,
  rowCount,
  oid: 0,
  fields: [],
  rows: [],
});

// Emulates the DECLARE/FETCH/MOVE/CLOSE protocol the shared executor drives for
// every read, so a chat read test measures what the app is actually handed
// rather than the whole result set.
const createCursorQueryFn = (
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): QueryFn => {
  let position = 0;
  return async (sql): Promise<PgQueryResult> => {
    if (sql.startsWith("DECLARE ")) {
      position = 0;
      return createAffectedRowsResult("DECLARE CURSOR", 0);
    }
    if (sql.startsWith("FETCH FORWARD ")) {
      const fetched = rows.slice(position, position + Number(sql.split(" ")[2]));
      position += fetched.length;
      return createQueryResult("FETCH", fetched);
    }
    if (sql.startsWith("MOVE FORWARD ALL ")) {
      const skipped = rows.length - position;
      position = rows.length;
      return createAffectedRowsResult("MOVE", skipped);
    }
    // CLOSE and the per-command statement_timeout setting, neither of which the
    // executor reads.
    return createAffectedRowsResult("SET", 0);
  };
};

const createUnusedRestrictedRunner = (): ExecQueryDependencies["withReadOnlyRestrictedUserContext"] =>
  async <T>(
    _userId: string,
    _workspaceId: string,
    _statementTimeoutMs: number,
    _callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    throw new Error("Restricted read transaction was not expected");
  };

test("cancel-first exact turn fencing rejects before mutating chat SQL", async (): Promise<void> => {
  let mutationCount = 0;
  const queryFn: QueryFn = async (sql): Promise<PgQueryResult> => {
    if (sql.startsWith("DELETE ")) {
      mutationCount += 1;
    }
    return createQueryResult("SELECT", []);
  };

  await assert.rejects(
    () => execQueryWithDependencies(
      validateSingleMutationExpenseSql("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'"),
      CONTEXT,
      WRITE_TARGET,
      {
        withUserContext: async <T>(
          _userId: string,
          _workspaceId: string,
          callback: (transactionQueryFn: QueryFn) => Promise<T>,
        ): Promise<T> => callback(queryFn),
        withReadOnlyRestrictedUserContext: createUnusedRestrictedRunner(),
        lockUncancelledChatTurnForMutationWithQuery:
          async (): Promise<void> => {
            throw new ChatTurnCancelledError("session-1", "turn-1");
          },
        now: Date.now,
      },
    ),
    ChatTurnCancelledError,
  );

  assert.equal(mutationCount, 0);
});

test("SQL-first exact turn fencing holds the session lock until mutation commit", async (): Promise<void> => {
  const mutationMayCommit = Promise.withResolvers<void>();
  const mutationStarted = Promise.withResolvers<void>();
  let transactionTail = Promise.resolve();
  let mutationCommitted = false;
  let cancellationConfirmed = false;

  const withSerializedSessionTransaction: ExecQueryDependencies["withUserContext"] =
    async <T>(
      _userId: string,
      _workspaceId: string,
      callback: (queryFn: QueryFn) => Promise<T>,
    ): Promise<T> => {
      const previousTransaction = transactionTail;
      const transactionFinished = Promise.withResolvers<void>();
      transactionTail = previousTransaction.then(
        (): Promise<void> => transactionFinished.promise,
      );
      await previousTransaction;
      const queryFn: QueryFn = async (sql): Promise<PgQueryResult> => {
        if (sql.startsWith("DELETE ")) {
          mutationStarted.resolve();
          await mutationMayCommit.promise;
          mutationCommitted = true;
          return createQueryResult("DELETE", []);
        }
        return createQueryResult("SELECT", []);
      };
      try {
        return await callback(queryFn);
      } finally {
        transactionFinished.resolve();
      }
    };

  const mutation = execQueryWithDependencies(
    validateSingleMutationExpenseSql("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'"),
    CONTEXT,
    WRITE_TARGET,
    {
      withUserContext: withSerializedSessionTransaction,
      withReadOnlyRestrictedUserContext: createUnusedRestrictedRunner(),
      lockUncancelledChatTurnForMutationWithQuery:
        async (): Promise<void> => {},
      now: Date.now,
    },
  );

  await mutationStarted.promise;
  const cancellation = withSerializedSessionTransaction(
    "user-1",
    "workspace-1",
    async (): Promise<void> => {
      cancellationConfirmed = true;
    },
  );
  await Promise.resolve();
  assert.equal(cancellationConfirmed, false);

  mutationMayCommit.resolve();
  await mutation;
  await cancellation;

  assert.equal(mutationCommitted, true);
  assert.equal(cancellationConfirmed, true);
});

// 600-char notes, the row width that makes an ordinary read oversized.
const createNoteRows = (rowCount: number): ReadonlyArray<Readonly<Record<string, string>>> =>
  Array.from({ length: rowCount }, (_value, index) => ({
    entry_id: `entry-${String(index)}`,
    note: "н".repeat(600),
  }));

type ChatSqlPayload = Readonly<{
  data: Readonly<{
    statements: ReadonlyArray<Readonly<{
      rows: ReadonlyArray<unknown>;
      rowCount: number;
      returnedRowCount: number;
      totalRowCount: number;
      truncated: boolean;
    }>>;
  }>;
}>;

// A long statement, the case where the echoed SQL is a large share of the
// emitted output.
const LONG_READ_STATEMENT = `SELECT entry_id, note FROM ledger_entries WHERE entry_id IN (${
  Array.from({ length: 500 }, (_value, index) => `'entry-${String(index)}'`).join(", ")
})`;

test("execQueryWithDependencies returns a chat result within budget unchanged", async (): Promise<void> => {
  const rows = createNoteRows(3);
  const queryFn = createCursorQueryFn(rows);

  const result = await execQueryWithDependencies(
    validateSingleReadOnlyExpenseSql("SELECT entry_id, note FROM ledger_entries LIMIT 3"),
    CONTEXT,
    READ_TARGET,
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withReadOnlyRestrictedUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        _statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: Date.now,
    },
  );

  const payload = JSON.parse(result.json) as ChatSqlPayload;
  const statement = payload.data.statements[0];

  assert.ok(statement);
  assert.ok(result.json.length < MAX_SQL_RESULT_CHARS);
  // The budget leaves a result that fits exactly as the statement built it.
  assert.deepEqual(statement.rows, rows);
  assert.equal(statement.rowCount, rows.length);
  assert.equal(statement.returnedRowCount, rows.length);
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, false);
});

test("execQueryWithDependencies caps the chat tool output the model receives in characters", async (): Promise<void> => {
  const rows = createNoteRows(100);
  const queryFn = createCursorQueryFn(rows);

  const result = await execQueryWithDependencies(
    validateSingleReadOnlyExpenseSql(LONG_READ_STATEMENT),
    CONTEXT,
    READ_TARGET,
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withReadOnlyRestrictedUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        _statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: Date.now,
    },
  );

  const payload = JSON.parse(result.json) as ChatSqlPayload;
  const statement = payload.data.statements[0];

  assert.ok(statement);
  assert.ok(LONG_READ_STATEMENT.length > 5_000);
  assert.ok(result.json.length <= MAX_SQL_RESULT_CHARS);
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < rows.length);
  assert.equal(statement.rowCount, statement.rows.length);
  assert.equal(statement.returnedRowCount, statement.rows.length);
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, true);
});

test("execQueryWithDependencies keeps the affected row count when a chat mutation is cut", async (): Promise<void> => {
  const rows = createNoteRows(60);
  const queryFn: QueryFn = async (statementSql): Promise<PgQueryResult> => (
    statementSql.startsWith("DELETE ")
      ? createQueryResult("DELETE", rows)
      : createQueryResult("SELECT", [])
  );

  const result = await execQueryWithDependencies(
    validateSingleMutationExpenseSql(
      "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1' RETURNING entry_id, note",
    ),
    CONTEXT,
    WRITE_TARGET,
    {
      withUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        callback: (mutatingQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      withReadOnlyRestrictedUserContext: createUnusedRestrictedRunner(),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: Date.now,
    },
  );

  const payload = JSON.parse(result.json) as ChatSqlPayload;
  const statement = payload.data.statements[0];

  assert.ok(statement);
  assert.ok(result.json.length <= MAX_SQL_RESULT_CHARS);
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < rows.length);
  // The write committed, so its rowCount keeps naming the rows it affected.
  assert.equal(statement.rowCount, rows.length);
  assert.equal(statement.returnedRowCount, statement.rows.length);
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, true);
});

// Narrow rows, so the cursor bound rather than the character budget is what
// decides how many rows a read returns.
const createNarrowRows = (
  rowCount: number,
): ReadonlyArray<Readonly<Record<string, string>>> =>
  Array.from({ length: rowCount }, (_value, index) => ({
    entry_id: `entry-${String(index)}`,
  }));

test("execQueryWithDependencies bounds a chat read at the cursor, not at the result set", async (): Promise<void> => {
  const rows = createNarrowRows(250);
  const cursorQueryFn = createCursorQueryFn(rows);
  let largestHandedRowCount = 0;
  const queryFn: QueryFn = async (statementSql, params): Promise<PgQueryResult> => {
    const result = await cursorQueryFn(statementSql, params);
    largestHandedRowCount = Math.max(largestHandedRowCount, result.rows.length);
    return result;
  };

  const result = await execQueryWithDependencies(
    validateSingleReadOnlyExpenseSql("SELECT entry_id FROM ledger_entries"),
    CONTEXT,
    READ_TARGET,
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withReadOnlyRestrictedUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        _statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: Date.now,
    },
  );

  const payload = JSON.parse(result.json) as ChatSqlPayload;
  const statement = payload.data.statements[0];

  assert.ok(statement);
  assert.equal(statement.rows.length, MAX_SQL_ROWS);
  assert.equal(statement.rowCount, MAX_SQL_ROWS);
  assert.equal(statement.returnedRowCount, MAX_SQL_ROWS);
  // Counted by the cursor without shipping the rows it skipped.
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, true);
  assert.equal(largestHandedRowCount, MAX_SQL_ROWS + 1);
});

/**
 * The policy error reaches the tool layer unwrapped, which is what lets the
 * emitted envelope carry its code, while the chat message adds the rollback fact
 * the policy message itself does not state.
 */
test("execQueryWithDependencies rejects a chat mutation over the shared row limit", async (): Promise<void> => {
  const affectedRowCount = MAX_SQL_MUTATION_ROWS + 1;
  const queryFn: QueryFn = async (statementSql): Promise<PgQueryResult> => (
    statementSql.startsWith("DELETE ")
      ? createAffectedRowsResult("DELETE", affectedRowCount)
      : createAffectedRowsResult("SET", 0)
  );

  await assert.rejects(
    () => execQueryWithDependencies(
      validateSingleMutationExpenseSql("DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1'"),
      CONTEXT,
      WRITE_TARGET,
      {
        withUserContext: async <T>(
          _userId: string,
          _workspaceId: string,
          callback: (mutatingQueryFn: QueryFn) => Promise<T>,
        ): Promise<T> => callback(queryFn),
        withReadOnlyRestrictedUserContext: createUnusedRestrictedRunner(),
        lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
        now: Date.now,
      },
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "mutation_statement_row_limit_exceeded"
      && getChatSqlPolicyMessage(error) === `A SQL mutation may affect at most ${String(MAX_SQL_MUTATION_ROWS)} rows per statement; this statement affected ${String(affectedRowCount)}. The whole call was rolled back, so nothing was written. Split the change into calls affecting at most ${String(MAX_SQL_MUTATION_ROWS)} rows each and retry`,
  );
});

test("execQueryWithDependencies turns an exhausted SQL deadline into an actionable chat error", async (): Promise<void> => {
  let currentTimeMs = 0;
  const cursorQueryFn = createCursorQueryFn(createNarrowRows(3));
  // Every database command burns the whole budget, so the command after the
  // first one starts past the deadline.
  const queryFn: QueryFn = async (statementSql, params): Promise<PgQueryResult> => {
    currentTimeMs += MCP_SQL_STATEMENT_TIMEOUT_MS;
    return cursorQueryFn(statementSql, params);
  };

  await assert.rejects(
    () => execQueryWithDependencies(
      validateSingleReadOnlyExpenseSql("SELECT entry_id FROM ledger_entries"),
      CONTEXT,
      READ_TARGET,
      {
        withUserContext: async (): Promise<never> => {
          throw new Error("User context should not run");
        },
        withReadOnlyRestrictedUserContext: async <T>(
          _userId: string,
          _workspaceId: string,
          _statementTimeoutMs: number,
          callback: (restrictedQueryFn: QueryFn) => Promise<T>,
        ): Promise<T> => callback(queryFn),
        lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
        now: (): number => currentTimeMs,
      },
    ),
    (error: unknown) =>
      error instanceof SqlExecutionDeadlineError
      && getChatSqlDeadlineMessage(error) === `SQL execution exceeded its ${String(MCP_SQL_STATEMENT_TIMEOUT_MS)} ms total deadline before the next database command could start. Any writes in this call were rolled back. Ask for less work per call: a shorter date range or fewer rows`,
  );
});

// One database command every fixed clock step, so every statement_timeout the
// chat emits is a deterministic integer the sequence tests below pin verbatim.
const COMMAND_CLOCK_STEP_MS = 25;

type RecordedCommand = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

// The turn lock runs its own SQL through the caller's queryFn in production.
// The fakes below record this sentinel in its place, so the assertions can pin
// the privilege-sensitive commands on both sides of it.
const MUTATION_TURN_LOCK_MARKER = "<lock uncancelled chat turn>";

const createRecordingQueryFn = (
  calls: Array<RecordedCommand>,
  advanceClock: () => void,
  respond: QueryFn,
): QueryFn =>
  async (sql, params): Promise<PgQueryResult> => {
    calls.push({ text: sql, params: [...params] });
    advanceClock();
    return respond(sql, params);
  };

// SET takes no bind parameters, so every one of these values is interpolated.
// These are the properties that make that safe: PostgreSQL accepts each emitted
// value as an integer number of milliseconds, the per-command budget only
// shrinks, and the last command restores the fixed allowance the commit that
// ends the transaction runs under.
const assertInterpolatedTimeouts = (
  calls: ReadonlyArray<RecordedCommand>,
): void => {
  const timeouts = calls
    .map((call) => /^SET LOCAL statement_timeout = (.*)$/u.exec(call.text)?.[1])
    .filter((value): value is string => value !== undefined);

  assert.ok(timeouts.length > 1);
  for (const timeout of timeouts) {
    assert.match(timeout, /^[0-9]+$/u);
    assert.equal(Number.isSafeInteger(Number(timeout)), true);
    assert.ok(Number(timeout) > 0);
    assert.ok(Number(timeout) <= MCP_SQL_STATEMENT_TIMEOUT_MS);
  }

  const values = timeouts.map(Number);
  assert.equal(values.at(-1), CHAT_SQL_COMMIT_TIMEOUT_MS);
  const commandBudgets = values.slice(0, -1);
  assert.equal(
    commandBudgets.every(
      (value, index) => index === 0 || value < commandBudgets[index - 1]!,
    ),
    true,
  );
};

test("execQueryWithDependencies bounds every chat read command with the budget still left", async (): Promise<void> => {
  const sql = "SELECT entry_id FROM ledger_entries";
  const calls: Array<RecordedCommand> = [];
  let currentTimeMs = 0;
  const queryFn = createRecordingQueryFn(
    calls,
    (): void => {
      currentTimeMs += COMMAND_CLOCK_STEP_MS;
    },
    createCursorQueryFn(createNarrowRows(3)),
  );

  await execQueryWithDependencies(
    validateSingleReadOnlyExpenseSql(sql),
    CONTEXT,
    READ_TARGET,
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withReadOnlyRestrictedUserContext: async <T>(
        _userId: string,
        workspaceId: string,
        statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => {
        assert.equal(statementTimeoutMs, MCP_SQL_STATEMENT_TIMEOUT_MS);
        // A read needs no chat session row, so it binds the target directly.
        // The repeatable-read read-only transaction and the api_sql_reader role
        // this runner opens are pinned in
        // apps/web/src/server/db/contextRunner.test.ts.
        assert.equal(workspaceId, TARGET_WORKSPACE.workspaceId);
        return callback(queryFn);
      },
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: (): number => currentTimeMs,
    },
  );

  assert.deepEqual(calls.map((call) => call.text), [
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS)}`,
    `DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR ${sql}`,
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS - (2 * COMMAND_CLOCK_STEP_MS))}`,
    `FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_1`,
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS - (4 * COMMAND_CLOCK_STEP_MS))}`,
    "MOVE FORWARD ALL FROM api_sql_read_cursor_1",
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS - (6 * COMMAND_CLOCK_STEP_MS))}`,
    "CLOSE api_sql_read_cursor_1",
    // The commit the context runner issues next runs on this fixed allowance,
    // not on whatever the cursor commands left of the deadline.
    `SET LOCAL statement_timeout = ${String(CHAT_SQL_COMMIT_TIMEOUT_MS)}`,
  ]);
  assertInterpolatedTimeouts(calls);
});

test("execQueryWithDependencies orders the chat mutation privilege commands around the turn lock", async (): Promise<void> => {
  const sql = "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'";
  const calls: Array<RecordedCommand> = [];
  let lockedWorkspaceId: string | null = null;
  let currentTimeMs = 0;
  const queryFn = createRecordingQueryFn(
    calls,
    (): void => {
      currentTimeMs += COMMAND_CLOCK_STEP_MS;
    },
    async (statementSql): Promise<PgQueryResult> => (
      statementSql.startsWith("DELETE ")
        ? createAffectedRowsResult("DELETE", 1)
        : createAffectedRowsResult("SET", 0)
    ),
  );

  await execQueryWithDependencies(
    validateSingleMutationExpenseSql(sql),
    CONTEXT,
    WRITE_TARGET,
    {
      withUserContext: async <T>(
        _userId: string,
        workspaceId: string,
        callback: (mutatingQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => {
        lockedWorkspaceId = workspaceId;
        return callback(queryFn);
      },
      withReadOnlyRestrictedUserContext: createUnusedRestrictedRunner(),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {
        calls.push({ text: MUTATION_TURN_LOCK_MARKER, params: [] });
      },
      now: (): number => currentTimeMs,
    },
  );

  // db/migrations/0012_restrict_set_config.sql grants EXECUTE on set_config()
  // to app alone, so both set_config() calls have to stay ahead of SET LOCAL
  // ROLE, the first has to bound the turn lock that follows it, and the second
  // has to come after that lock is held.
  assert.deepEqual(calls.map((call) => call.text), [
    "SELECT set_config('statement_timeout', $1, true)",
    MUTATION_TURN_LOCK_MARKER,
    "SELECT set_config('app.workspace_id', $1, true)",
    "SET LOCAL ROLE api_sql_executor",
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS - (3 * COMMAND_CLOCK_STEP_MS))}`,
    sql,
    // A write that spent nearly the whole deadline still commits on this fixed
    // allowance rather than on what little the deadline had left.
    `SET LOCAL statement_timeout = ${String(CHAT_SQL_COMMIT_TIMEOUT_MS)}`,
  ]);
  assert.deepEqual(calls[0]?.params, [String(MCP_SQL_STATEMENT_TIMEOUT_MS)]);
  // The transaction opens on the session's workspace, so the chat session row
  // the turn lock reads is visible, and only then binds the target workspace.
  assert.equal(lockedWorkspaceId, CONTEXT.workspaceId);
  assert.deepEqual(calls[2]?.params, [TARGET_WORKSPACE.workspaceId]);
  assertInterpolatedTimeouts(calls);
});

type ChatSqlPolicyCase = Readonly<{
  code: ConstructorParameters<typeof SqlPolicyError>[0];
  policyMessage: string;
  chatMessage: string;
}>;

/**
 * Every branch of getChatSqlPolicyMessage that rewrites or extends the shared
 * policy message. That text is hand-written and reaches the model verbatim, so
 * nothing else in the repository would notice it being emptied by a refactor.
 */
const CHAT_SQL_POLICY_CASES: ReadonlyArray<ChatSqlPolicyCase> = [
  {
    code: "single_statement_required",
    policyMessage: "Exactly one SQL statement is required",
    chatMessage: "Exactly one SQL statement is required. One call is one transaction, so rows that have to land together, such as both sides of a transfer, belong in one multi-row statement rather than in separate calls",
  },
  {
    code: "mutation_statement_row_limit_exceeded",
    policyMessage: "A SQL mutation may affect at most 500 rows per statement",
    chatMessage: `A SQL mutation may affect at most 500 rows per statement. The whole call was rolled back, so nothing was written. Split the change into calls affecting at most ${String(MAX_SQL_MUTATION_ROWS)} rows each and retry`,
  },
  {
    code: "mutation_request_row_limit_exceeded",
    policyMessage: "A SQL request may affect at most 500 rows",
    chatMessage: `A SQL request may affect at most 500 rows. The whole call was rolled back, so nothing was written. Split the change into calls affecting at most ${String(MAX_SQL_MUTATION_ROWS)} rows each and retry`,
  },
  {
    code: "on_conflict_not_allowed",
    policyMessage: "ON CONFLICT is not supported",
    chatMessage: "ON CONFLICT is not supported in chat queries",
  },
  {
    code: "set_config_not_allowed",
    policyMessage: "set_config() is not allowed",
    chatMessage: "set_config() calls are not allowed",
  },
  {
    code: "sql_comments_not_allowed",
    policyMessage: "SQL comments are not allowed",
    chatMessage: "SQL comments are not allowed in chat queries",
  },
  {
    code: "quoted_identifiers_not_allowed",
    policyMessage: "Quoted identifiers are not allowed",
    chatMessage: "Quoted identifiers are not allowed in chat queries",
  },
  {
    code: "dollar_quoted_strings_not_allowed",
    policyMessage: "Dollar-quoted strings are not allowed",
    chatMessage: "Dollar-quoted strings are not allowed in chat queries",
  },
  {
    code: "escape_string_literals_not_allowed",
    policyMessage: "E'...' escape strings are not allowed",
    chatMessage: "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.",
  },
  {
    code: "unterminated_string_literal",
    policyMessage: "Unterminated string literal",
    chatMessage: "Unterminated SQL string literal",
  },
  {
    code: "invalid_relation_reference",
    policyMessage: "Invalid relation reference",
    chatMessage: "Expected relation name after SQL clause",
  },
  {
    code: "relation_not_allowed",
    policyMessage: "Relation pg_stat_activity is not allowed",
    chatMessage: "Relation pg_stat_activity is not allowed in chat queries",
  },
  {
    code: "recursive_cte_search_cycle_not_allowed",
    policyMessage: "Recursive CTE SEARCH and CYCLE clauses are not supported",
    chatMessage: "Recursive CTE SEARCH and CYCLE clauses are not supported in chat queries. Rewrite the CTE without those clauses",
  },
  {
    code: "read_only_relation_mutation_not_allowed",
    policyMessage: "Relation accounts is read-only",
    chatMessage: "Relation accounts is read-only. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata",
  },
];

test("getChatSqlPolicyMessage keeps its chat-specific remediation for every branch that adds one", (): void => {
  for (const policyCase of CHAT_SQL_POLICY_CASES) {
    assert.equal(
      getChatSqlPolicyMessage(new SqlPolicyError(policyCase.code, policyCase.policyMessage)),
      policyCase.chatMessage,
      `getChatSqlPolicyMessage lost the remediation for ${policyCase.code}`,
    );
  }
});

test("getChatSqlPolicyMessage passes through a policy message that already stands alone", (): void => {
  const policyMessage = "Read-only SQL cannot contain INSERT, UPDATE, DELETE, or data-modifying CTEs";
  assert.equal(
    getChatSqlPolicyMessage(new SqlPolicyError("read_only_sql_required", policyMessage)),
    policyMessage,
  );
});
