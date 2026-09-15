import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import {
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  CHAT_SQL_COMMIT_TIMEOUT_MS,
  CHAT_SQL_TOOL_NAME,
  execQuery,
  execQueryWithDependencies,
  type ExecQueryDependencies,
} from "@/server/chat/shared";
import { ChatTurnCancelledError } from "@/server/chat/store";
import type { QueryFn } from "@/server/db/contextRunner";

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

const createUnusedRestrictedRunner = (): ExecQueryDependencies["withRestrictedUserContext"] =>
  async <T>(
    _userId: string,
    _workspaceId: string,
    _statementTimeoutMs: number,
    _callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    throw new Error("Restricted read transaction was not expected");
  };

test("execQuery rejects function calls before reaching the database", async (): Promise<void> => {
  await assert.rejects(
    () => execQuery("SELECT pg_sleep(1)", {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message.startsWith("Function pg_sleep() is not allowed in restricted SQL. Allowed functions: "),
  );
});

test("execQuery explains how to replace PostgreSQL escape strings", async (): Promise<void> => {
  await assert.rejects(
    () => execQuery("SELECT E'value' FROM ledger_entries", {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.",
  );
});

test("execQuery rejects data-modifying CTEs before database or mutation lock entry", async (): Promise<void> => {
  let userContextCount = 0;
  let restrictedContextCount = 0;
  let mutationLockCount = 0;

  await assert.rejects(
    () => execQueryWithDependencies(
      "WITH changed AS (UPDATE account_metadata SET liquidity = 'low' RETURNING *) SELECT * FROM changed",
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      {
        withUserContext: async (): Promise<never> => {
          userContextCount += 1;
          throw new Error("User context should not run");
        },
        withRestrictedUserContext: async (): Promise<never> => {
          restrictedContextCount += 1;
          throw new Error("Restricted context should not run");
        },
        lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {
          mutationLockCount += 1;
        },
        now: Date.now,
      },
    ),
    (error: unknown) =>
      error instanceof Error
      && error.message === "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
  );

  assert.equal(userContextCount, 0);
  assert.equal(restrictedContextCount, 0);
  assert.equal(mutationLockCount, 0);
});

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
      "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'",
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      {
        withUserContext: async <T>(
          _userId: string,
          _workspaceId: string,
          callback: (transactionQueryFn: QueryFn) => Promise<T>,
        ): Promise<T> => callback(queryFn),
        withRestrictedUserContext: createUnusedRestrictedRunner(),
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
    "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'",
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: withSerializedSessionTransaction,
      withRestrictedUserContext: createUnusedRestrictedRunner(),
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

// The success output apps/web/src/server/chat/openai/tooling/tools.ts emits for
// one tool call, which is what the model reads, what the turn re-sends, and
// what the transcript stores and renders.
const buildChatToolOutput = (sql: string, json: string): string => JSON.stringify({
  ok: true,
  tool: CHAT_SQL_TOOL_NAME,
  sql,
  ...JSON.parse(json) as Readonly<Record<string, unknown>>,
});

type ChatSqlPayload = Readonly<{
  statements: ReadonlyArray<Readonly<{
    rows: ReadonlyArray<unknown>;
    rowCount: number;
    returnedRowCount: number;
    totalRowCount: number;
    truncated: boolean;
  }>>;
}>;

// A long script, the case where the echo the tool layer adds around the
// statements array is a large share of the emitted output.
const LONG_SCRIPT = `SELECT entry_id, note FROM ledger_entries WHERE entry_id IN (${
  Array.from({ length: 500 }, (_value, index) => `'entry-${String(index)}'`).join(", ")
})`;

test("execQueryWithDependencies returns a chat result within budget unchanged", async (): Promise<void> => {
  const rows = createNoteRows(3);
  const sql = "SELECT entry_id, note FROM ledger_entries LIMIT 3";
  const queryFn = createCursorQueryFn(rows);

  const result = await execQueryWithDependencies(
    sql,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withRestrictedUserContext: async <T>(
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
  const statement = payload.statements[0];

  assert.ok(statement);
  assert.ok(buildChatToolOutput(sql, result.json).length < MAX_SQL_RESULT_CHARS);
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
    LONG_SCRIPT,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withRestrictedUserContext: async <T>(
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
  const statement = payload.statements[0];

  assert.ok(statement);
  assert.ok(LONG_SCRIPT.length > 5_000);
  assert.ok(buildChatToolOutput(LONG_SCRIPT, result.json).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(statement.rows.length > 0);
  assert.ok(statement.rows.length < rows.length);
  assert.equal(statement.rowCount, statement.rows.length);
  assert.equal(statement.returnedRowCount, statement.rows.length);
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, true);
});

test("execQueryWithDependencies keeps the affected row count when a chat mutation is cut", async (): Promise<void> => {
  const rows = createNoteRows(60);
  const sql = "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1' RETURNING entry_id, note";
  const queryFn: QueryFn = async (statementSql): Promise<PgQueryResult> => (
    statementSql.startsWith("DELETE ")
      ? createQueryResult("DELETE", rows)
      : createQueryResult("SELECT", [])
  );

  const result = await execQueryWithDependencies(
    sql,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        callback: (mutatingQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      withRestrictedUserContext: createUnusedRestrictedRunner(),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
      now: Date.now,
    },
  );

  const payload = JSON.parse(result.json) as ChatSqlPayload;
  const statement = payload.statements[0];

  assert.ok(statement);
  assert.ok(buildChatToolOutput(sql, result.json).length <= MAX_SQL_RESULT_CHARS);
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
  const sql = "SELECT entry_id FROM ledger_entries";
  const cursorQueryFn = createCursorQueryFn(rows);
  let largestHandedRowCount = 0;
  const queryFn: QueryFn = async (statementSql, params): Promise<PgQueryResult> => {
    const result = await cursorQueryFn(statementSql, params);
    largestHandedRowCount = Math.max(largestHandedRowCount, result.rows.length);
    return result;
  };

  const result = await execQueryWithDependencies(
    sql,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withRestrictedUserContext: async <T>(
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
  const statement = payload.statements[0];

  assert.ok(statement);
  assert.equal(statement.rows.length, MAX_SQL_ROWS);
  assert.equal(statement.rowCount, MAX_SQL_ROWS);
  assert.equal(statement.returnedRowCount, MAX_SQL_ROWS);
  // Counted by the cursor without shipping the rows it skipped.
  assert.equal(statement.totalRowCount, rows.length);
  assert.equal(statement.truncated, true);
  assert.equal(largestHandedRowCount, MAX_SQL_ROWS + 1);
});

test("execQueryWithDependencies rejects a chat mutation over the shared row limit", async (): Promise<void> => {
  const affectedRowCount = MAX_SQL_MUTATION_ROWS + 1;
  const queryFn: QueryFn = async (statementSql): Promise<PgQueryResult> => (
    statementSql.startsWith("DELETE ")
      ? createAffectedRowsResult("DELETE", affectedRowCount)
      : createAffectedRowsResult("SET", 0)
  );

  await assert.rejects(
    () => execQueryWithDependencies(
      "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1'",
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      {
        withUserContext: async <T>(
          _userId: string,
          _workspaceId: string,
          callback: (mutatingQueryFn: QueryFn) => Promise<T>,
        ): Promise<T> => callback(queryFn),
        withRestrictedUserContext: createUnusedRestrictedRunner(),
        lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {},
        now: Date.now,
      },
    ),
    (error: unknown) =>
      error instanceof Error
      && error.message === `A SQL mutation may affect at most ${String(MAX_SQL_MUTATION_ROWS)} rows per statement; this statement affected ${String(affectedRowCount)}. The whole call was rolled back, so nothing was written. Split the change into calls affecting at most ${String(MAX_SQL_MUTATION_ROWS)} rows each and retry`,
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
      "SELECT entry_id FROM ledger_entries",
      {
        userId: "user-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      {
        withUserContext: async (): Promise<never> => {
          throw new Error("User context should not run");
        },
        withRestrictedUserContext: async <T>(
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
      error instanceof Error
      && error.message === `SQL execution exceeded its ${String(MCP_SQL_STATEMENT_TIMEOUT_MS)} ms total deadline before the next database command could start. Any writes in this call were rolled back. Ask for less work per call: a shorter date range, fewer rows, or fewer statements in one script`,
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
    sql,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async (): Promise<never> => {
        throw new Error("User context should not run");
      },
      withRestrictedUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => {
        assert.equal(statementTimeoutMs, MCP_SQL_STATEMENT_TIMEOUT_MS);
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
    sql,
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    },
    {
      withUserContext: async <T>(
        _userId: string,
        _workspaceId: string,
        callback: (mutatingQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
      withRestrictedUserContext: createUnusedRestrictedRunner(),
      lockUncancelledChatTurnForMutationWithQuery: async (): Promise<void> => {
        calls.push({ text: MUTATION_TURN_LOCK_MARKER, params: [] });
      },
      now: (): number => currentTimeMs,
    },
  );

  // db/migrations/0012_restrict_set_config.sql grants EXECUTE on set_config()
  // to app alone, so the one set_config() call has to stay ahead of SET LOCAL
  // ROLE, and it has to bound the turn lock that follows it.
  assert.deepEqual(calls.map((call) => call.text), [
    "SELECT set_config('statement_timeout', $1, true)",
    MUTATION_TURN_LOCK_MARKER,
    "SET LOCAL ROLE api_sql_executor",
    `SET LOCAL statement_timeout = ${String(MCP_SQL_STATEMENT_TIMEOUT_MS - (2 * COMMAND_CLOCK_STEP_MS))}`,
    sql,
    // A write that spent nearly the whole deadline still commits on this fixed
    // allowance rather than on what little the deadline had left.
    `SET LOCAL statement_timeout = ${String(CHAT_SQL_COMMIT_TIMEOUT_MS)}`,
  ]);
  assert.deepEqual(calls[0]?.params, [String(MCP_SQL_STATEMENT_TIMEOUT_MS)]);
  assertInterpolatedTimeouts(calls);
});
