/**
 * Database URL resolution for SQL API Lambdas.
 *
 * Lambda: fetches credentials from Secrets Manager using DB_SECRET_ARN,
 * then constructs the URL from DB_HOST and DB_NAME.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

export const DATABASE_SECRET_TIMEOUT_MS = 5_000;

export type DatabaseConfigTimerHandle = object;

export type DatabaseConfigRuntime = Readonly<{
  schedule: (callback: () => void, delayMs: number) => DatabaseConfigTimerHandle;
  cancel: (handle: DatabaseConfigTimerHandle) => void;
}>;

type SecretValueClient = Readonly<{
  send: (
    command: GetSecretValueCommand,
    options: Readonly<{ abortSignal: AbortSignal }>,
  ) => Promise<GetSecretValueCommandOutput>;
  destroy: () => void;
}>;

type DatabaseUrlResolverDependencies = Readonly<{
  createSecretsClient: () => SecretValueClient;
  readEnvironment: () => NodeJS.ProcessEnv;
  runtime: DatabaseConfigRuntime;
}>;

export type DatabaseUrlResolver = Readonly<{
  getDatabaseUrl: (timeoutMs: number) => Promise<string>;
}>;

type SecretCredentials = Readonly<{
  username: string;
  password: string;
}>;

export class DatabaseSecretTimeoutError extends Error {
  readonly secretArn: string;
  readonly timeoutMs: number;

  constructor(secretArn: string, timeoutMs: number, cause: unknown) {
    super(`Database secret ${secretArn} retrieval exceeded its ${String(timeoutMs)} ms deadline`, { cause });
    this.secretArn = secretArn;
    this.timeoutMs = timeoutMs;
  }
}

const systemDatabaseConfigRuntime: DatabaseConfigRuntime = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const requireEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Database configuration requires a non-empty ${name} environment variable`);
  }
  return value;
};

const parseSecretCredentials = (
  secretArn: string,
  secretString: string | undefined,
): SecretCredentials => {
  if (secretString === undefined) {
    throw new Error(`Database secret ${secretArn} does not contain SecretString credentials`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch (error) {
    throw new Error(`Database secret ${secretArn} is not valid JSON`, { cause: error });
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || !("username" in parsed)
    || typeof parsed.username !== "string"
    || parsed.username.length === 0
    || !("password" in parsed)
    || typeof parsed.password !== "string"
  ) {
    throw new Error(`Database secret ${secretArn} must contain non-empty username and string password fields`);
  }

  return {
    username: parsed.username,
    password: parsed.password,
  };
};

const loadDatabaseUrl = async (
  dependencies: DatabaseUrlResolverDependencies,
  timeoutMs: number,
): Promise<string> => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Database secret timeout must be a positive safe integer number of milliseconds");
  }

  const environment = dependencies.readEnvironment();
  const secretArn = environment.DB_SECRET_ARN;
  if (typeof secretArn !== "string" || secretArn.length === 0) {
    return requireEnvironmentValue(environment, "DATABASE_URL");
  }

  const host = requireEnvironmentValue(environment, "DB_HOST");
  const dbName = requireEnvironmentValue(environment, "DB_NAME");
  const client = dependencies.createSecretsClient();
  const controller = new AbortController();
  const timeoutError = new DatabaseSecretTimeoutError(secretArn, timeoutMs, undefined);
  const timeoutHandle = dependencies.runtime.schedule(
    () => controller.abort(timeoutError),
    timeoutMs,
  );

  try {
    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
      { abortSignal: controller.signal },
    );
    const credentials = parseSecretCredentials(secretArn, response.SecretString);
    return `postgresql://${credentials.username}:${encodeURIComponent(credentials.password)}@${host}:5432/${dbName}`;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new DatabaseSecretTimeoutError(secretArn, timeoutMs, error);
    }
    throw new Error(`Failed to retrieve database secret ${secretArn}`, { cause: error });
  } finally {
    dependencies.runtime.cancel(timeoutHandle);
    client.destroy();
  }
};

export const createDatabaseUrlResolver = (
  dependencies: DatabaseUrlResolverDependencies,
): DatabaseUrlResolver => {
  let resolvedDatabaseUrl: string | undefined;
  let initialization: Promise<string> | undefined;

  const getDatabaseUrl = (timeoutMs: number): Promise<string> => {
    if (resolvedDatabaseUrl !== undefined) {
      return Promise.resolve(resolvedDatabaseUrl);
    }
    if (initialization !== undefined) {
      return initialization;
    }

    const startedInitialization = loadDatabaseUrl(dependencies, timeoutMs);
    initialization = startedInitialization;
    void startedInitialization.then(
      (databaseUrl) => {
        resolvedDatabaseUrl = databaseUrl;
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

  return { getDatabaseUrl };
};

const databaseUrlResolver = createDatabaseUrlResolver({
  createSecretsClient: () => new SecretsManagerClient({}),
  readEnvironment: () => process.env,
  runtime: systemDatabaseConfigRuntime,
});

export const getDatabaseUrl = (timeoutMs: number): Promise<string> =>
  databaseUrlResolver.getDatabaseUrl(timeoutMs);
