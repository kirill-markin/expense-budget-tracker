import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import {
  createSqlExecutionDeadline,
  SqlExecutionDeadlineError,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { createQueryResult } from "./handlerTestUtils.js";
import {
  acquirePoolClientBeforeDeadline,
  type DeadlinePool,
  type DeadlineRuntime,
  type DeadlineTimerHandle,
  type DeadlineTransaction,
  SQL_TRANSACTION_CLEANUP_TIMEOUT_MS,
  SqlTransactionOutcomeUnknownError,
  withDeadlineTransactionUsingPool,
  withReadOnlyDeadlineTransactionUsingPool,
} from "./dbDeadline.js";

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

const createManualRuntime = (
  readTimeMs: () => number,
): Readonly<{
  runtime: DeadlineRuntime;
  tasks: Array<ScheduledTask>;
}> => {
  const tasks: Array<ScheduledTask> = [];
  return {
    tasks,
    runtime: {
      now: readTimeMs,
      schedule: (callback, delayMs): DeadlineTimerHandle => {
        const task: ScheduledTask = { callback, delayMs, cancelled: false };
        tasks.push(task);
        return task;
      },
      cancel: (handle): void => {
        (handle as ScheduledTask).cancelled = true;
      },
    },
  };
};

const createPoolClient = (
  queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>,
  releases: Array<Error | undefined>,
): pg.PoolClient => ({
  query: queryFn,
  release: (error?: Error | boolean): void => {
    releases.push(error instanceof Error ? error : undefined);
  },
} as pg.PoolClient);

test("deadline-aware pool acquisition rejects wait expiry and discards a late client", async (): Promise<void> => {
  let poolCallback: Parameters<DeadlinePool["connect"]>[0] | undefined;
  const pool: DeadlinePool = {
    connect: (callback): void => {
      poolCallback = callback;
    },
  };
  const { runtime, tasks } = createManualRuntime(() => 1_000);
  const deadline = createSqlExecutionDeadline(20_000, () => 1_000);
  const releases: Array<Error | undefined> = [];
  const client = createPoolClient(async () => createQueryResult([]), releases);

  const acquisition = acquirePoolClientBeforeDeadline(pool, deadline, runtime);
  const rejected = assert.rejects(
    acquisition,
    (error: unknown) => error instanceof SqlExecutionDeadlineError,
  );
  const acquisitionTimeout = tasks[0];
  assert.ok(acquisitionTimeout !== undefined);
  assert.equal(acquisitionTimeout.delayMs, 20_000);
  acquisitionTimeout.callback();
  await rejected;
  assert.ok(poolCallback !== undefined);
  poolCallback(undefined, client);

  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof SqlExecutionDeadlineError);
});

test("bounded transactions refresh server and hard deadlines before setup, role, mutation, and commit", async (): Promise<void> => {
  let currentTimeMs = 5_000;
  let mutationDispatchCallCount: number | undefined;
  const calls: Array<Readonly<{ text: string; params: ReadonlyArray<unknown> }>> = [];
  const releases: Array<Error | undefined> = [];
  const client = createPoolClient(async (text, params) => {
    calls.push({ text, params });
    currentTimeMs += 25;
    return createQueryResult([]);
  }, releases);
  const pool: DeadlinePool = {
    connect: (callback): void => callback(undefined, client),
  };
  const { runtime, tasks } = createManualRuntime(() => currentTimeMs);
  const deadline = createSqlExecutionDeadline(20_000, () => currentTimeMs);

  await withDeadlineTransactionUsingPool(
    pool,
    deadline,
    "BEGIN",
    async (transaction): Promise<void> => {
      await transaction.query("SELECT set_config('app.user_id', $1, true)", ["user-1"], 20_000);
      await transaction.query("SET LOCAL ROLE api_sql_executor", [], 20_000);
      await transaction.queryWithDispatchMarker(
        "DELETE FROM budget_lines WHERE category = $1",
        ["Food"],
        20_000,
        () => {
          mutationDispatchCallCount = calls.length;
        },
      );
    },
    runtime,
  );

  assert.deepEqual(calls.map((call) => call.text), [
    "BEGIN; SET LOCAL statement_timeout = 20000; SET LOCAL transaction_timeout = 20000",
    "SET LOCAL statement_timeout = 19975",
    "SELECT set_config('app.user_id', $1, true)",
    "SET LOCAL statement_timeout = 19925",
    "SET LOCAL ROLE api_sql_executor",
    "SET LOCAL statement_timeout = 19875",
    "DELETE FROM budget_lines WHERE category = $1",
    "SET LOCAL statement_timeout = 19825",
    "RESET ROLE",
    "SET LOCAL statement_timeout = 19775",
    "COMMIT",
  ]);
  const configuredTimeouts = calls
    .map((call) => /statement_timeout = ([0-9]+)/u.exec(call.text)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  assert.deepEqual(configuredTimeouts, [20_000, 19_975, 19_925, 19_875, 19_825, 19_775]);
  assert.ok(mutationDispatchCallCount !== undefined);
  assert.equal(mutationDispatchCallCount, 6);
  assert.equal(calls[mutationDispatchCallCount - 1]?.text, "SET LOCAL statement_timeout = 19875");
  assert.equal(calls[mutationDispatchCallCount]?.text, "DELETE FROM budget_lines WHERE category = $1");
  assert.equal(configuredTimeouts.every(
    (timeout, index) => index === 0 || timeout < configuredTimeouts[index - 1]!,
  ), true);
  assert.equal(tasks.length, calls.length + 1);
  assert.deepEqual(tasks.map((task) => task.delayMs), [
    20_000,
    20_000,
    19_975,
    19_950,
    19_925,
    19_900,
    19_875,
    19_850,
    19_825,
    19_800,
    19_775,
    19_750,
  ]);
  assert.equal(tasks.every((task) => task.cancelled), true);
  assert.deepEqual(releases, [undefined]);
});

test("rollback cleanup is bounded and discards a client that cannot become transaction-idle", async (): Promise<void> => {
  const calls: Array<string> = [];
  const releases: Array<Error | undefined> = [];
  const client = createPoolClient(async (text) => {
    calls.push(text);
    if (text === "ROLLBACK") {
      return new Promise<pg.QueryResult>(() => undefined);
    }
    return createQueryResult([]);
  }, releases);
  const pool: DeadlinePool = {
    connect: (callback): void => callback(undefined, client),
  };
  const { runtime, tasks } = createManualRuntime(() => 10_000);
  const deadline = createSqlExecutionDeadline(20_000, () => 10_000);
  const transactionError = new Error("transaction callback failed");
  const transaction = withDeadlineTransactionUsingPool(
    pool,
    deadline,
    "BEGIN",
    async (): Promise<void> => {
      throw transactionError;
    },
    runtime,
  );
  const rejected = assert.rejects(
    transaction,
    (error: unknown) =>
      error instanceof SqlTransactionOutcomeUnknownError
      && error.failurePhase === "transaction"
      && error.originalError === transactionError
      && error.rollbackOutcome === "unknown"
      && error.cleanupError instanceof SqlExecutionDeadlineError,
  );

  while (!calls.includes("ROLLBACK")) {
    await Promise.resolve();
  }
  const cleanupTimeout = [...tasks].reverse().find(
    (task) => !task.cancelled && task.delayMs === SQL_TRANSACTION_CLEANUP_TIMEOUT_MS,
  );
  assert.ok(cleanupTimeout !== undefined);
  cleanupTimeout.callback();
  await rejected;

  assert.deepEqual(calls, [
    "BEGIN; SET LOCAL statement_timeout = 20000; SET LOCAL transaction_timeout = 20000",
    "ROLLBACK",
  ]);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof SqlExecutionDeadlineError);
  assert.equal(transactionError.cause, undefined);
});

test("an expired transaction rolls back without dispatching role reset or commit", async (): Promise<void> => {
  let currentTimeMs = 30_000;
  const calls: Array<string> = [];
  const releases: Array<Error | undefined> = [];
  const client = createPoolClient(async (text) => {
    calls.push(text);
    return createQueryResult([]);
  }, releases);
  const pool: DeadlinePool = {
    connect: (callback): void => callback(undefined, client),
  };
  const { runtime } = createManualRuntime(() => currentTimeMs);
  const deadline = createSqlExecutionDeadline(20_000, () => currentTimeMs);

  await assert.rejects(
    () => withDeadlineTransactionUsingPool(
      pool,
      deadline,
      "BEGIN",
      async (): Promise<void> => {
        currentTimeMs += 20_000;
      },
      runtime,
    ),
    (error: unknown) => error instanceof SqlExecutionDeadlineError,
  );

  assert.deepEqual(calls, [
    "BEGIN; SET LOCAL statement_timeout = 20000; SET LOCAL transaction_timeout = 20000",
    "ROLLBACK",
  ]);
  assert.deepEqual(releases, [undefined]);
});

const readOnlyDeadlineScenarios: ReadonlyArray<Readonly<{
  name: string;
  isBlockedCommand: (text: string) => boolean;
  callback: (transaction: DeadlineTransaction) => Promise<void>;
}>> = [
  {
    name: "begin",
    isBlockedCommand: (text) => text.startsWith("BEGIN READ ONLY;"),
    callback: async () => undefined,
  },
  {
    name: "query",
    isBlockedCommand: (text) => text === "SELECT 1",
    callback: async (transaction) => {
      await transaction.query("SELECT 1", [], 20_000);
    },
  },
  {
    name: "commit",
    isBlockedCommand: (text) => text === "COMMIT",
    callback: async () => undefined,
  },
];

for (const scenario of readOnlyDeadlineScenarios) {
  test(`read-only ${scenario.name} deadline remains a retryable deadline error`, async (): Promise<void> => {
    const calls: Array<string> = [];
    const releases: Array<Error | undefined> = [];
    const client = createPoolClient(async (text) => {
      calls.push(text);
      if (scenario.isBlockedCommand(text)) {
        return new Promise<pg.QueryResult>(() => undefined);
      }
      return createQueryResult([]);
    }, releases);
    const pool: DeadlinePool = {
      connect: (callback): void => callback(undefined, client),
    };
    const { runtime, tasks } = createManualRuntime(() => 10_000);
    const deadline = createSqlExecutionDeadline(20_000, () => 10_000);
    const transaction = withReadOnlyDeadlineTransactionUsingPool(
      pool,
      deadline,
      "BEGIN READ ONLY",
      scenario.callback,
      runtime,
    );
    const rejected = assert.rejects(
      transaction,
      (error: unknown) => error instanceof SqlExecutionDeadlineError,
    );

    while (!calls.some(scenario.isBlockedCommand)) {
      await Promise.resolve();
    }
    const activeTimeout = [...tasks].reverse().find((task) => !task.cancelled);
    assert.ok(activeTimeout !== undefined);
    activeTimeout.callback();
    await rejected;

    assert.equal(releases.length, 1);
    assert.ok(releases[0] instanceof SqlExecutionDeadlineError);
  });
}
