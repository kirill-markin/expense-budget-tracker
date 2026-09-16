import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResult } from "pg";
import { createDbFacade } from "@/server/db/facade";
import type { DbClient } from "@/server/db/contextRunner";
import type { UserIdentity } from "@/server/users";

const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user-1@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

const STATEMENT_TIMEOUT_MS = 20_000;

type RecordedCommand = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type ProvisioningCall = Readonly<{
  method: "ensureUserProvisioned" | "ensureTrustedIdentityProvisioned";
  userId: string;
  workspaceId: string;
  /** Zero when provisioning ran before the transaction opened. */
  commandsIssuedBefore: number;
}>;

const emptyResult = (command: string): QueryResult => ({
  command,
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
});

/**
 * A structural stand-in for pg.Pool: the facade only ever calls connect(), and
 * the cast keeps the driver's much wider surface out of the test.
 */
const createRecordingPool = (commands: Array<RecordedCommand>): Pool => ({
  connect: async (): Promise<DbClient> => ({
    query: async (text: string, params?: Array<unknown>): Promise<QueryResult> => {
      commands.push({ text, params: params ?? [] });
      return emptyResult(text);
    },
    release: (): void => {},
  }),
} as unknown as Pool);

type Harness = Readonly<{
  facade: ReturnType<typeof createDbFacade>;
  commands: Array<RecordedCommand>;
  provisioning: Array<ProvisioningCall>;
}>;

const createHarness = (): Harness => {
  const commands: Array<RecordedCommand> = [];
  const provisioning: Array<ProvisioningCall> = [];
  const pool = createRecordingPool(commands);
  return {
    commands,
    provisioning,
    facade: createDbFacade({
      query: async (): Promise<QueryResult> => {
        throw new Error("Bare pool query was not expected");
      },
      getPool: (): Pool => pool,
      ensureUserProvisioned: async (userId, workspaceId): Promise<void> => {
        provisioning.push({
          method: "ensureUserProvisioned",
          userId,
          workspaceId,
          commandsIssuedBefore: commands.length,
        });
      },
      ensureTrustedIdentityProvisioned: async (identity, workspaceId): Promise<void> => {
        provisioning.push({
          method: "ensureTrustedIdentityProvisioned",
          userId: identity.userId,
          workspaceId,
          commandsIssuedBefore: commands.length,
        });
      },
    }),
  };
};

const contextCommands = (
  userId: string,
  workspaceId: string,
  role: string,
): ReadonlyArray<RecordedCommand> => [
  { text: "SELECT set_config('app.user_id', $1, true)", params: [userId] },
  { text: "SELECT set_config('app.workspace_id', $1, true)", params: [workspaceId] },
  {
    text: "SELECT set_config('statement_timeout', $1, true)",
    params: [String(STATEMENT_TIMEOUT_MS)],
  },
  { text: `SET LOCAL ROLE ${role}`, params: [] },
];

/**
 * The privilege each facade method hands the context runner is the decision, and
 * the runner honours whatever it is given. Pinning the emitted command sequence
 * here is what keeps a read from silently regaining write privilege: swapping
 * api_sql_reader back to api_sql_executor, or the read-only transaction start
 * back to a plain BEGIN, has to fail a test rather than pass unnoticed.
 */
test("a restricted read runs read-only as api_sql_reader after provisioning the user", async (): Promise<void> => {
  const harness = createHarness();

  await harness.facade.withReadOnlyRestrictedUserContext(
    "user-1",
    "workspace-2",
    STATEMENT_TIMEOUT_MS,
    async (queryFn) => queryFn("SELECT account_id FROM accounts", []),
  );

  assert.deepEqual(harness.provisioning, [{
    method: "ensureUserProvisioned",
    userId: "user-1",
    workspaceId: "workspace-2",
    commandsIssuedBefore: 0,
  }]);
  assert.deepEqual(harness.commands, [
    {
      text: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      params: [],
    },
    ...contextCommands("user-1", "workspace-2", "api_sql_reader"),
    { text: "SELECT account_id FROM accounts", params: [] },
    { text: "COMMIT", params: [] },
  ]);
});

test("a restricted trusted-identity read runs read-only as api_sql_reader after provisioning the identity", async (): Promise<void> => {
  const harness = createHarness();

  await harness.facade.withReadOnlyRestrictedTrustedIdentityContext(
    IDENTITY,
    "workspace-2",
    STATEMENT_TIMEOUT_MS,
    async (queryFn) => queryFn("SELECT account_id FROM accounts", []),
  );

  // Provisioning is where workspace membership is checked, so it runs before
  // the transaction opens.
  assert.deepEqual(harness.provisioning, [{
    method: "ensureTrustedIdentityProvisioned",
    userId: IDENTITY.userId,
    workspaceId: "workspace-2",
    commandsIssuedBefore: 0,
  }]);
  // The role switch comes after every set_config, which api_sql_reader cannot
  // execute, and before the user SQL, which must run as the reader.
  assert.deepEqual(harness.commands, [
    {
      text: "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      params: [],
    },
    { text: "SELECT set_config('app.user_id', $1, true)", params: [IDENTITY.userId] },
    { text: "SELECT set_config('app.workspace_id', $1, true)", params: ["workspace-2"] },
    {
      text: "SELECT set_config('statement_timeout', $1, true)",
      params: [String(STATEMENT_TIMEOUT_MS)],
    },
    { text: "SET LOCAL ROLE api_sql_reader", params: [] },
    { text: "SELECT account_id FROM accounts", params: [] },
    { text: "COMMIT", params: [] },
  ]);
});

test("a restricted trusted-identity call runs writable as api_sql_executor", async (): Promise<void> => {
  const harness = createHarness();

  await harness.facade.withRestrictedTrustedIdentityContext(
    IDENTITY,
    "workspace-2",
    STATEMENT_TIMEOUT_MS,
    async (queryFn) => queryFn("DELETE FROM ledger_entries WHERE entry_id = 'entry-1'", []),
  );

  assert.deepEqual(harness.provisioning, [{
    method: "ensureTrustedIdentityProvisioned",
    userId: IDENTITY.userId,
    workspaceId: "workspace-2",
    commandsIssuedBefore: 0,
  }]);
  assert.deepEqual(harness.commands, [
    { text: "BEGIN", params: [] },
    ...contextCommands(IDENTITY.userId, "workspace-2", "api_sql_executor"),
    {
      text: "DELETE FROM ledger_entries WHERE entry_id = 'entry-1'",
      params: [],
    },
    { text: "COMMIT", params: [] },
  ]);
});

/**
 * The chat's mutation path runs its turn lock and its set_config calls as the
 * app role and switches to api_sql_executor itself, so this method must hand the
 * runner no role and no timeout of its own.
 */
test("a plain user context stays unrestricted so its caller can set the role", async (): Promise<void> => {
  const harness = createHarness();

  await harness.facade.withUserContext(
    "user-1",
    "workspace-1",
    async (queryFn) => queryFn("SELECT 1", []),
  );

  assert.deepEqual(harness.commands, [
    { text: "BEGIN", params: [] },
    { text: "SELECT set_config('app.user_id', $1, true)", params: ["user-1"] },
    { text: "SELECT set_config('app.workspace_id', $1, true)", params: ["workspace-1"] },
    { text: "SELECT 1", params: [] },
    { text: "COMMIT", params: [] },
  ]);
});
