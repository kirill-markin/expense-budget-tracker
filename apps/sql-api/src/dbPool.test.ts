import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { SQL_API_DB_POOL_MAX_CONNECTIONS } from "@expense-budget-tracker/agent-shared";
import {
  createSqlExecutionDeadline,
  SqlExecutionDeadlineError,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type {
  DeadlineRuntime,
  DeadlineTimerHandle,
} from "./dbDeadline.js";
import {
  createDatabasePoolProvider,
  POSTGRES_CONNECTION_TIMEOUT_MS,
  waitForPoolBeforeDeadline,
} from "./dbPool.js";

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

const createPool = (): pg.Pool => ({}) as pg.Pool;

test("pool initialization is shared and configures bounded PostgreSQL connection establishment", async (): Promise<void> => {
  let resolveDatabaseUrl: ((databaseUrl: string) => void) | undefined;
  let databaseUrlRequestCount = 0;
  const poolConfigs: Array<pg.PoolConfig> = [];
  const expectedPool = createPool();
  const provider = createDatabasePoolProvider({
    createPool: (config) => {
      poolConfigs.push(config);
      return expectedPool;
    },
    getDatabaseUrl: () => {
      databaseUrlRequestCount += 1;
      return new Promise<string>((resolve) => {
        resolveDatabaseUrl = resolve;
      });
    },
    useTls: () => true,
  });

  const first = provider.getPool();
  const second = provider.getPool();
  assert.equal(first, second);
  assert.equal(databaseUrlRequestCount, 1);
  assert.ok(resolveDatabaseUrl !== undefined);
  resolveDatabaseUrl("postgresql://database.example.internal/expense_tracker");

  assert.equal(await first, expectedPool);
  assert.equal(await second, expectedPool);
  assert.equal(poolConfigs.length, 1);
  assert.equal(poolConfigs[0]?.max, SQL_API_DB_POOL_MAX_CONNECTIONS);
  assert.equal(poolConfigs[0]?.connectionTimeoutMillis, POSTGRES_CONNECTION_TIMEOUT_MS);
  assert.equal(poolConfigs[0]?.ssl, true);
});

test("pool initialization clears failed shared state without creating a pool", async (): Promise<void> => {
  let databaseUrlRequestCount = 0;
  let poolCreationCount = 0;
  const expectedPool = createPool();
  const provider = createDatabasePoolProvider({
    createPool: () => {
      poolCreationCount += 1;
      return expectedPool;
    },
    getDatabaseUrl: async () => {
      databaseUrlRequestCount += 1;
      if (databaseUrlRequestCount === 1) {
        throw new Error("database URL unavailable");
      }
      return "postgresql://database.example.internal/expense_tracker";
    },
    useTls: () => false,
  });

  await assert.rejects(provider.getPool(), /database URL unavailable/u);
  assert.equal(await provider.getPool(), expectedPool);
  assert.equal(databaseUrlRequestCount, 2);
  assert.equal(poolCreationCount, 1);
});

test("a short first SQL caller does not shorten shared pool initialization for a longer caller", async (): Promise<void> => {
  let resolveDatabaseUrl: ((databaseUrl: string) => void) | undefined;
  const initializationTimeouts: Array<number> = [];
  const expectedPool = createPool();
  const provider = createDatabasePoolProvider({
    createPool: () => expectedPool,
    getDatabaseUrl: (timeoutMs) => new Promise<string>((resolve) => {
      initializationTimeouts.push(timeoutMs);
      resolveDatabaseUrl = resolve;
    }),
    useTls: () => false,
  });
  const { runtime, tasks } = createManualRuntime(() => 10_000);
  const shortDeadline = createSqlExecutionDeadline(1_000, () => 10_000);
  const longDeadline = createSqlExecutionDeadline(10_000, () => 10_000);

  const shortWait = waitForPoolBeforeDeadline(provider, shortDeadline, runtime);
  const longWait = waitForPoolBeforeDeadline(provider, longDeadline, runtime);
  const rejected = assert.rejects(
    shortWait,
    (error: unknown) => error instanceof SqlExecutionDeadlineError && error.timeoutMs === 1_000,
  );
  const timeoutTask = tasks[0];
  assert.ok(timeoutTask !== undefined);
  assert.equal(timeoutTask.delayMs, 1_000);
  assert.equal(tasks[1]?.delayMs, 10_000);
  assert.deepEqual(initializationTimeouts, [5_000]);
  timeoutTask.callback();
  await rejected;

  assert.ok(resolveDatabaseUrl !== undefined);
  resolveDatabaseUrl("postgresql://database.example.internal/expense_tracker");
  assert.equal(await longWait, expectedPool);
  assert.equal(await provider.getPool(), expectedPool);
});

test("a SQL caller always gives shared pool initialization its fixed five-second budget", async (): Promise<void> => {
  let receivedInitializationTimeoutMs = 0;
  const expectedPool = createPool();
  const provider = createDatabasePoolProvider({
    createPool: () => expectedPool,
    getDatabaseUrl: async (timeoutMs) => {
      receivedInitializationTimeoutMs = timeoutMs;
      return "postgresql://database.example.internal/expense_tracker";
    },
    useTls: () => false,
  });
  const { runtime } = createManualRuntime(() => 12_000);
  const deadline = createSqlExecutionDeadline(3_000, () => 12_000);

  assert.equal(await waitForPoolBeforeDeadline(provider, deadline, runtime), expectedPool);
  assert.equal(receivedInitializationTimeoutMs, 5_000);
});
