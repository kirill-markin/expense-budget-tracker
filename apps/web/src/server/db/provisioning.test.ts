import assert from "node:assert/strict";
import test from "node:test";
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
        case "BEGIN":
        case "COMMIT":
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
});

const isAccessErrorForIdentity = (error: unknown): boolean =>
  error instanceof WorkspaceAccessError
  && error.userId === USER_ID
  && error.workspaceId === WORKSPACE_ID;

test("a removed member is rejected on the next call while settings writes stay cached", async (): Promise<void> => {
  resetProvisioningCachesForTests();
  const commands: Array<string> = [];
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: false };
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
  const state: FakeDatabaseState = { isMember: true, hasWorkspaceSettings: true };
  let conflictOnUpsert = true;
  const dependencies = createDependencies(
    createFakePool(state, []),
    async (): Promise<void> => {
      if (conflictOnUpsert) {
        throw Object.assign(
          new Error("duplicate key value violates unique constraint \"idx_users_email\""),
          { code: "23505", constraint: "idx_users_email" },
        );
      }
    },
    [],
  );

  await ensureProvisionedIdentity(IDENTITY, WORKSPACE_ID, dependencies);

  state.isMember = false;
  conflictOnUpsert = false;
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
