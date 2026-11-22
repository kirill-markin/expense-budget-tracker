import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { QueryResult } from "pg";

import type { SupportedLocale } from "@/lib/locale";
import type { DbClient, DbPool } from "@/server/db/contextRunner";
import { ensureProvisionedIdentity, resetProvisioningCachesForTests } from "@/server/db/provisioning";
import type { UserIdentity } from "@/server/users";
import { WorkspaceAccessError } from "@/server/workspaceErrors";

type ProvisioningDependencies = Parameters<typeof ensureProvisionedIdentity>[2];

/** Committed rows the fake database reports; tests flip them between calls. */
type FakeDatabaseState = {
  isMember: boolean;
  hasWorkspaceSettings: boolean;
  failsCommit: boolean;
};

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

const IDENTITY: UserIdentity = {
  userId: USER_ID,
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

const OTHER_IDENTITY: UserIdentity = { ...IDENTITY, userId: "user-2", email: "other@example.com" };

const SET_USER_ID = "SELECT set_config('app.user_id', $1, true)";
const SET_WORKSPACE_ID = "SELECT set_config('app.workspace_id', $1, true)";
const MEMBERSHIP_CHECK = "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2";
const WORKSPACE_SETTINGS_CHECK = "SELECT 1 FROM workspace_settings WHERE workspace_id = $1";
const WORKSPACE_SETTINGS_INSERT = "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD')";

const existsResult = (exists: boolean): QueryResult => ({
  command: "SELECT",
  rowCount: exists ? 1 : 0,
  oid: 0,
  fields: [],
  rows: exists ? [{ "?column?": 1 }] : [],
});

const createFakePool = (state: FakeDatabaseState, commands: Array<string>): DbPool => ({
  connect: async (): Promise<DbClient> => ({
    query: async (text): Promise<QueryResult> => {
      commands.push(text);
      switch (text) {
        case "COMMIT":
          if (state.failsCommit) {
            throw new Error("Fake COMMIT failure");
          }
          return existsResult(false);
        case "BEGIN":
        case "ROLLBACK":
        case SET_USER_ID:
        case SET_WORKSPACE_ID:
          return existsResult(false);
        case "SELECT 1 FROM users WHERE user_id = $1":
        case "SELECT 1 FROM user_settings WHERE user_id = $1":
          return existsResult(true);
        case MEMBERSHIP_CHECK:
          return existsResult(state.isMember);
        case WORKSPACE_SETTINGS_CHECK:
          return existsResult(state.hasWorkspaceSettings);
        case WORKSPACE_SETTINGS_INSERT:
          state.hasWorkspaceSettings = true;
          return existsResult(false);
        default:
          throw new Error(`Unexpected provisioning query: ${text}`);
      }
    },
    release: (): void => {},
  }),
});

const createDependencies = (
  pool: DbPool,
  upsertIdentity: ProvisioningDependencies["upsertIdentity"],
  commands: Array<string>,
): ProvisioningDependencies => ({
  pool,
  getInitialLocale: async (): Promise<SupportedLocale> => "en",
  upsertIdentity,
  ensureUserSettings: async (): Promise<void> => {
    commands.push("ensureUserSettings");
  },
  recordOpenDay: async (): Promise<void> => {
    commands.push("recordOpenDay");
  },
});

const isAccessErrorForIdentity = (error: unknown): boolean =>
  error instanceof WorkspaceAccessError
  && error.userId === USER_ID
  && error.workspaceId === WORKSPACE_ID;

test("a removed member is rejected on the next call while settings writes stay cached", async (): Promise<void> => {
  resetProvisioningCachesForTests();
  const commands: Array<string> = [];
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: false, failsCommit: false };
  const dependencies = createDependencies(
    createFakePool(state, commands),
    async (): Promise<void> => {
      commands.push("upsertIdentity");
    },
    commands,
  );

  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  assert.deepEqual(commands.splice(0), [
    "BEGIN",
    SET_USER_ID,
    SET_WORKSPACE_ID,
    "upsertIdentity",
    "recordOpenDay",
    MEMBERSHIP_CHECK,
    WORKSPACE_SETTINGS_CHECK,
    WORKSPACE_SETTINGS_INSERT,
    "ensureUserSettings",
    "COMMIT",
  ]);

  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  assert.deepEqual(commands.splice(0), [
    "BEGIN",
    SET_USER_ID,
    SET_WORKSPACE_ID,
    "upsertIdentity",
    MEMBERSHIP_CHECK,
    "COMMIT",
  ]);

  state.isMember = false;
  await assert.rejects(
    () => ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies),
    isAccessErrorForIdentity,
  );
});

test("an expected provisioning conflict never exempts a removed member from the membership check", async (): Promise<void> => {
  resetProvisioningCachesForTests();
  const commands: Array<string> = [];
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: true, failsCommit: false };
  let conflictOnUpsert = true;
  const dependencies = createDependencies(
    createFakePool(state, commands),
    async (): Promise<void> => {
      commands.push("upsertIdentity");
      if (conflictOnUpsert) {
        throw Object.assign(
          new Error("duplicate key value violates unique constraint \"idx_users_email\""),
          { code: "23505", constraint: "idx_users_email" },
        );
      }
    },
    commands,
  );

  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  commands.splice(0);

  // The conflict rolled the open day back, so the next call must record it.
  conflictOnUpsert = false;
  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  assert.deepEqual(commands.splice(0), [
    "BEGIN",
    SET_USER_ID,
    SET_WORKSPACE_ID,
    "upsertIdentity",
    "recordOpenDay",
    MEMBERSHIP_CHECK,
    "COMMIT",
  ]);

  state.isMember = false;
  await assert.rejects(
    () => ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies),
    isAccessErrorForIdentity,
  );

  conflictOnUpsert = true;
  await assert.rejects(
    () => ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies),
    isAccessErrorForIdentity,
  );
});

test("a rejected call leaves the open day unrecorded for the next allowed call", async (): Promise<void> => {
  resetProvisioningCachesForTests();
  const commands: Array<string> = [];
  const state: FakeDatabaseState = { isMember: false, hasWorkspaceSettings: true, failsCommit: false };
  const dependencies = createDependencies(
    createFakePool(state, commands),
    async (): Promise<void> => {
      commands.push("upsertIdentity");
    },
    commands,
  );

  await assert.rejects(
    () => ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies),
    isAccessErrorForIdentity,
  );
  commands.splice(0);

  state.isMember = true;
  state.failsCommit = true;
  await assert.rejects(
    () => ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies),
    /Fake COMMIT failure/,
  );
  assert.ok(commands.splice(0).includes("recordOpenDay"));

  state.failsCommit = false;
  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  assert.ok(commands.splice(0).includes("recordOpenDay"));
});

test("a new UTC day records the open day again for every user", async (t: TestContext): Promise<void> => {
  resetProvisioningCachesForTests();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T23:59:59.000Z") });
  const commands: Array<string> = [];
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: true, failsCommit: false };
  const dependencies = createDependencies(
    createFakePool(state, commands),
    async (): Promise<void> => {
      commands.push("upsertIdentity");
    },
    commands,
  );

  for (const identity of [IDENTITY, OTHER_IDENTITY]) {
    await ensureProvisionedIdentity(identity, WORKSPACE_ID, dependencies);
    assert.ok(commands.splice(0).includes("recordOpenDay"));
  }

  t.mock.timers.tick(2_000);
  for (const identity of [IDENTITY, OTHER_IDENTITY]) {
    await ensureProvisionedIdentity(identity, WORKSPACE_ID, dependencies);
    assert.ok(commands.splice(0).includes("recordOpenDay"));
  }
});

test("a request from the previous UTC day that commits late keeps the current day cached", async (t: TestContext): Promise<void> => {
  resetProvisioningCachesForTests();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-22T23:59:59.000Z") });
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: true, failsCommit: false };
  const slowUpsertStarted = Promise.withResolvers<void>();
  const slowUpsertReleased = Promise.withResolvers<void>();
  const slowCommands: Array<string> = [];
  const slowDependencies = createDependencies(
    createFakePool(state, slowCommands),
    async (): Promise<void> => {
      slowUpsertStarted.resolve();
      await slowUpsertReleased.promise;
    },
    slowCommands,
  );
  const commands: Array<string> = [];
  const dependencies = createDependencies(
    createFakePool(state, commands),
    async (): Promise<void> => {
      commands.push("upsertIdentity");
    },
    commands,
  );

  const slowCall = ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, slowDependencies);
  await slowUpsertStarted.promise;

  t.mock.timers.tick(2_000);
  await ensureProvisionedIdentity(OTHER_IDENTITY, WORKSPACE_ID, dependencies);
  assert.ok(commands.splice(0).includes("recordOpenDay"));

  slowUpsertReleased.resolve();
  await slowCall;
  assert.ok(slowCommands.includes("recordOpenDay"));

  await ensureProvisionedIdentity(OTHER_IDENTITY, WORKSPACE_ID, dependencies);
  assert.ok(!commands.splice(0).includes("recordOpenDay"));
  // The slow call recorded only the previous day.
  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);
  assert.ok(commands.splice(0).includes("recordOpenDay"));
});
