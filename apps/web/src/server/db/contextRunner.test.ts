import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  DbTransactionOutcomeUnknownError,
  runWithContext,
  runWithReadOnlyContext,
  type ContextRunnerOptions,
  type DbClient,
  type DbPool,
} from "@/server/db/contextRunner";

const READER_OPTIONS: ContextRunnerOptions = {
  userId: "user-1",
  workspaceId: "workspace-1",
  statementTimeoutMs: 20_000,
  restrictedRole: "api_sql_reader",
};

const EXECUTOR_OPTIONS: ContextRunnerOptions = {
  userId: "user-1",
  workspaceId: "workspace-1",
  statementTimeoutMs: 20_000,
  restrictedRole: "api_sql_executor",
};

const emptyResult = (command: string): QueryResult => ({
  command,
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
});

const createRecordingPool = (
  commands: Array<string>,
  respond: (text: string) => Promise<QueryResult>,
): DbPool => ({
  connect: async (): Promise<DbClient> => ({
    query: async (text): Promise<QueryResult> => {
      commands.push(text);
      return respond(text);
    },
    release: (): void => {},
  }),
});

const succeed = async (text: string): Promise<QueryResult> => emptyResult(text);

/**
 * The read-only transaction mode and the reader role are the chat sql_query
 * tool's second layer of defence: they hold whether or not the statement was
 * validated. db/migrations/0012_restrict_set_config.sql grants EXECUTE on
 * set_config() to app alone, so the role switch also has to come after the whole
 * RLS context is set and before any user SQL runs.
 */
test("a read-only context runs a repeatable-read transaction under api_sql_reader", async (): Promise<void> => {
  const commands: Array<string> = [];

  await runWithReadOnlyContext(
    createRecordingPool(commands, succeed),
    READER_OPTIONS,
    async (queryFn) => queryFn("SELECT entry_id FROM ledger_entries", []),
  );

  assert.deepEqual(commands, [
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "SELECT set_config('app.user_id', $1, true)",
    "SELECT set_config('app.workspace_id', $1, true)",
    "SELECT set_config('statement_timeout', $1, true)",
    "SET LOCAL ROLE api_sql_reader",
    "SELECT entry_id FROM ledger_entries",
    "COMMIT",
  ]);
});

test("a writable restricted context runs a plain transaction under api_sql_executor", async (): Promise<void> => {
  const commands: Array<string> = [];

  await runWithContext(
    createRecordingPool(commands, succeed),
    EXECUTOR_OPTIONS,
    async (queryFn) => queryFn("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'", []),
  );

  assert.deepEqual(commands, [
    "BEGIN",
    "SELECT set_config('app.user_id', $1, true)",
    "SELECT set_config('app.workspace_id', $1, true)",
    "SELECT set_config('statement_timeout', $1, true)",
    "SET LOCAL ROLE api_sql_executor",
    "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'",
    "COMMIT",
  ]);
});

test("a transaction body that rolls back cleanly raises its own error", async (): Promise<void> => {
  const bodyError = new Error("relation missing_accounts does not exist");
  const commands: Array<string> = [];

  await assert.rejects(
    () => runWithContext(
      createRecordingPool(commands, succeed),
      EXECUTOR_OPTIONS,
      async (): Promise<never> => {
        throw bodyError;
      },
    ),
    (error: unknown) => error === bodyError,
  );

  assert.equal(commands.at(-1), "ROLLBACK");
});

/**
 * A COMMIT that never reported back may still have been applied, so the caller
 * has to be able to tell this apart from a statement the database rejected.
 * The chat's sql_execute turns exactly this error into "verify, do not retry".
 */
test("a COMMIT that does not report back leaves the outcome unknown", async (): Promise<void> => {
  const commitError = new Error("Connection terminated unexpectedly");
  const commands: Array<string> = [];
  const pool = createRecordingPool(commands, async (text): Promise<QueryResult> => {
    if (text === "COMMIT") {
      throw commitError;
    }
    return emptyResult(text);
  });

  await assert.rejects(
    () => runWithContext(
      pool,
      EXECUTOR_OPTIONS,
      async (queryFn) => queryFn("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'", []),
    ),
    (error: unknown) =>
      error instanceof DbTransactionOutcomeUnknownError
      && error.failurePhase === "commit"
      && error.originalError === commitError
      && error.cause === commitError,
  );

  // The connection is cleaned up before it goes back to the pool.
  assert.equal(commands.at(-1), "ROLLBACK");
});

test("a rollback that also fails leaves the outcome unknown and keeps both errors", async (): Promise<void> => {
  const bodyError = new Error("relation missing_accounts does not exist");
  const rollbackError = new Error("Connection terminated unexpectedly");
  const pool = createRecordingPool([], async (text): Promise<QueryResult> => {
    if (text === "ROLLBACK") {
      throw rollbackError;
    }
    return emptyResult(text);
  });

  await assert.rejects(
    () => runWithContext(
      pool,
      EXECUTOR_OPTIONS,
      async (): Promise<never> => {
        throw bodyError;
      },
    ),
    (error: unknown) =>
      error instanceof DbTransactionOutcomeUnknownError
      && error.failurePhase === "transaction"
      && error.originalError === bodyError
      && error.cause instanceof AggregateError,
  );
});
