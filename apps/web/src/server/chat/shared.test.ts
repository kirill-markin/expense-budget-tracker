import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import {
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
    () => execQuery("SELECT now()", {
      userId: "user-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    }),
    (error: unknown) =>
      error instanceof Error
      && error.message === "Function now() is not allowed in restricted SQL. Allowed functions: SUM, COUNT, MIN, MAX, AVG, COALESCE",
  );
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
