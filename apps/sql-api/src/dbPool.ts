import pg from "pg";
import { SQL_API_DB_POOL_MAX_CONNECTIONS } from "@expense-budget-tracker/agent-shared";
import {
  getRemainingSqlExecutionMs,
  SqlExecutionDeadlineError,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  DATABASE_SECRET_TIMEOUT_MS,
  getDatabaseUrl,
} from "./config.js";
import type { DeadlineRuntime } from "./dbDeadline.js";

export const POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;

export type DatabasePoolProvider = Readonly<{
  getPool: () => Promise<pg.Pool>;
}>;

type DatabasePoolProviderDependencies = Readonly<{
  createPool: (config: pg.PoolConfig) => pg.Pool;
  getDatabaseUrl: (timeoutMs: number) => Promise<string>;
  useTls: () => boolean;
}>;

export const createDatabasePoolProvider = (
  dependencies: DatabasePoolProviderDependencies,
): DatabasePoolProvider => {
  let initializedPool: pg.Pool | undefined;
  let initialization: Promise<pg.Pool> | undefined;

  const getPool = (): Promise<pg.Pool> => {
    if (initializedPool !== undefined) {
      return Promise.resolve(initializedPool);
    }
    if (initialization !== undefined) {
      return initialization;
    }

    const startedInitialization = dependencies.getDatabaseUrl(DATABASE_SECRET_TIMEOUT_MS).then(
      (connectionString): pg.Pool => dependencies.createPool({
        connectionString,
        ssl: dependencies.useTls(),
        max: SQL_API_DB_POOL_MAX_CONNECTIONS,
        connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
      }),
    );
    initialization = startedInitialization;
    void startedInitialization.then(
      (createdPool) => {
        initializedPool = createdPool;
        if (initialization === startedInitialization) {
          initialization = undefined;
        }
      },
      () => {
        if (initialization === startedInitialization) {
          initialization = undefined;
        }
      },
    );
    return startedInitialization;
  };

  return { getPool };
};

export const waitForPoolBeforeDeadline = (
  provider: DatabasePoolProvider,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
): Promise<pg.Pool> => {
  const remainingMs = getRemainingSqlExecutionMs(deadline);
  const initialization = provider.getPool();

  return new Promise<pg.Pool>((resolve, reject) => {
    let completed = false;
    const timeoutHandle = runtime.schedule(() => {
      if (completed) return;
      completed = true;
      reject(new SqlExecutionDeadlineError(deadline.timeoutMs));
    }, remainingMs);

    initialization.then(
      (databasePool) => {
        if (completed) return;
        completed = true;
        runtime.cancel(timeoutHandle);
        try {
          getRemainingSqlExecutionMs(deadline);
          resolve(databasePool);
        } catch (error) {
          reject(error);
        }
      },
      (error: Error) => {
        if (completed) return;
        completed = true;
        runtime.cancel(timeoutHandle);
        reject(error);
      },
    );
  });
};

export const databasePoolProvider = createDatabasePoolProvider({
  // RDS certificates require the bundled Amazon CA configured by the Lambda.
  createPool: (config) => new pg.Pool(config),
  getDatabaseUrl,
  useTls: () => typeof process.env.DB_SECRET_ARN === "string" && process.env.DB_SECRET_ARN.length > 0,
});

export const getPool = (): Promise<pg.Pool> =>
  databasePoolProvider.getPool();
