import assert from "node:assert/strict";
import test from "node:test";
import type { GetSecretValueCommandOutput } from "@aws-sdk/client-secrets-manager";
import {
  createDatabaseUrlResolver,
  DatabaseSecretTimeoutError,
  type DatabaseConfigRuntime,
  type DatabaseConfigTimerHandle,
} from "./config.js";

type ScheduledTask = {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
};

const createManualRuntime = (): Readonly<{
  runtime: DatabaseConfigRuntime;
  tasks: Array<ScheduledTask>;
}> => {
  const tasks: Array<ScheduledTask> = [];
  return {
    tasks,
    runtime: {
      schedule: (callback, delayMs): DatabaseConfigTimerHandle => {
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

const createSecretOutput = (): GetSecretValueCommandOutput => ({
  SecretString: JSON.stringify({ username: "database-user", password: "database-password" }),
  $metadata: {},
});

const databaseEnvironment = (): NodeJS.ProcessEnv => ({
  DB_SECRET_ARN: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:database",
  DB_HOST: "database.example.internal",
  DB_NAME: "expense_tracker",
});

test("database secret retrieval aborts the AWS request at its deadline and destroys the client", async (): Promise<void> => {
  const { runtime, tasks } = createManualRuntime();
  let receivedSignal: AbortSignal | undefined;
  let destroyed = false;
  const resolver = createDatabaseUrlResolver({
    createSecretsClient: () => ({
      send: (_command, options) => {
        receivedSignal = options.abortSignal;
        return new Promise<GetSecretValueCommandOutput>((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
        });
      },
      destroy: (): void => {
        destroyed = true;
      },
    }),
    readEnvironment: databaseEnvironment,
    runtime,
  });

  const resolution = resolver.getDatabaseUrl(2_000);
  const timeoutTask = tasks[0];
  assert.ok(timeoutTask !== undefined);
  assert.equal(timeoutTask.delayMs, 2_000);
  timeoutTask.callback();

  await assert.rejects(
    resolution,
    (error: unknown) =>
      error instanceof DatabaseSecretTimeoutError
      && error.timeoutMs === 2_000
      && error.secretArn === databaseEnvironment().DB_SECRET_ARN,
  );
  assert.ok(receivedSignal !== undefined);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(destroyed, true);
  assert.equal(timeoutTask.cancelled, true);
});

test("database URL initialization clears a failed cache entry before retrying", async (): Promise<void> => {
  const { runtime } = createManualRuntime();
  let requestCount = 0;
  const resolver = createDatabaseUrlResolver({
    createSecretsClient: () => ({
      send: async (): Promise<GetSecretValueCommandOutput> => {
        requestCount += 1;
        if (requestCount === 1) {
          throw new Error("temporary Secrets Manager failure");
        }
        return createSecretOutput();
      },
      destroy: (): void => undefined,
    }),
    readEnvironment: databaseEnvironment,
    runtime,
  });

  await assert.rejects(
    resolver.getDatabaseUrl(2_000),
    /Failed to retrieve database secret/u,
  );
  const databaseUrl = await resolver.getDatabaseUrl(2_000);

  assert.equal(requestCount, 2);
  assert.equal(
    databaseUrl,
    "postgresql://database-user:database-password@database.example.internal:5432/expense_tracker",
  );
});

test("concurrent database URL callers share one bounded secret request", async (): Promise<void> => {
  const { runtime } = createManualRuntime();
  let requestCount = 0;
  let resolveSecret: ((output: GetSecretValueCommandOutput) => void) | undefined;
  const resolver = createDatabaseUrlResolver({
    createSecretsClient: () => ({
      send: () => {
        requestCount += 1;
        return new Promise<GetSecretValueCommandOutput>((resolve) => {
          resolveSecret = resolve;
        });
      },
      destroy: (): void => undefined,
    }),
    readEnvironment: databaseEnvironment,
    runtime,
  });

  const first = resolver.getDatabaseUrl(2_000);
  const second = resolver.getDatabaseUrl(1_000);
  assert.equal(first, second);
  assert.equal(requestCount, 1);
  assert.ok(resolveSecret !== undefined);
  resolveSecret(createSecretOutput());

  assert.equal(await first, await second);
});
