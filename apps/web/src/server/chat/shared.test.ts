import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import { MAX_SQL_RESULT_CHARS } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
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
  const queryFn: QueryFn = async (): Promise<PgQueryResult> => createQueryResult("SELECT", rows);

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
  const queryFn: QueryFn = async (): Promise<PgQueryResult> => createQueryResult("SELECT", rows);

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
