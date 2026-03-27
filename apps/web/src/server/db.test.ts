import assert from "node:assert/strict";
import test from "node:test";

import { type QueryResult } from "pg";

import { runWithContext } from "@/server/db/contextRunner";
import { createDbFacade } from "@/server/db/facade";
import {
  ensureProvisionedIdentity,
  ensureUserProvisionedWithResolver,
  resetProvisioningCachesForTests,
} from "@/server/db/provisioning";
import { type UserIdentity } from "@/server/users";

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type FakeClient = Readonly<{
  calls: Array<QueryCall>;
  released: { current: boolean };
  query: (text: string, params?: Array<unknown>) => Promise<QueryResult>;
  release: () => void;
}>;

type QueryBehavior = (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;

const createEmptyResult = (): QueryResult => ({
  command: "SELECT",
  rowCount: 0,
  oid: 0,
  rows: [],
  fields: [],
});

const createResultWithRows = (rowCount: number): QueryResult => ({
  command: "SELECT",
  rowCount,
  oid: 0,
  rows: Array.from({ length: rowCount }, () => ({ ok: true })),
  fields: [],
});

const createFakeClient = (behavior: QueryBehavior): FakeClient => {
  const calls: Array<QueryCall> = [];
  const released = { current: false };

  return {
    calls,
    released,
    query: async (text: string, params?: Array<unknown>): Promise<QueryResult> => {
      const safeParams = params ?? [];
      calls.push({ text, params: safeParams });
      return behavior(text, safeParams);
    },
    release: (): void => {
      released.current = true;
    },
  };
};

const createIdentity = (userId: string): UserIdentity => ({
  userId,
  email: `${userId}@example.com`,
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
});

test("ensureUserProvisionedWithResolver rejects mismatched header identity", async () => {
  let ensured = false;

  await assert.rejects(
    ensureUserProvisionedWithResolver(
      async () => createIdentity("actual-user"),
      async () => {
        ensured = true;
      },
      "expected-user",
      "workspace-1",
    ),
    /Identity header mismatch: expected user expected-user, got actual-user/,
  );

  assert.equal(ensured, false);
});

test("runWithContext commits on success and rolls back on failure", async () => {
  const successClient = createFakeClient(async () => createEmptyResult());

  const successValue = await runWithContext(
    { connect: async () => successClient },
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      statementTimeoutMs: null,
      useRestrictedRole: false,
    },
    async (queryFn) => {
      await queryFn("SELECT 42", []);
      return "ok";
    },
  );

  assert.equal(successValue, "ok");
  assert.deepEqual(
    successClient.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 42",
      "COMMIT",
    ],
  );
  assert.equal(successClient.released.current, true);

  const failureClient = createFakeClient(async (text) => {
    if (text === "SELECT broken") {
      throw new Error("boom");
    }
    return createEmptyResult();
  });

  await assert.rejects(
    runWithContext(
      { connect: async () => failureClient },
      {
        userId: "user-2",
        workspaceId: "workspace-2",
        statementTimeoutMs: null,
        useRestrictedRole: false,
      },
      async (queryFn) => queryFn("SELECT broken", []),
    ),
    /boom/,
  );
  assert.deepEqual(
    failureClient.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT broken",
      "ROLLBACK",
    ],
  );
  assert.equal(failureClient.released.current, true);
});

test("runWithContext applies timeout and restricted role before SQL", async () => {
  const client = createFakeClient(async () => createEmptyResult());

  await runWithContext(
    { connect: async () => client },
    {
      userId: "user-1",
      workspaceId: "workspace-1",
      statementTimeoutMs: 1500,
      useRestrictedRole: true,
    },
    async (queryFn) => queryFn("SELECT current_user", []),
  );

  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      "SET LOCAL ROLE api_sql_executor",
      "SELECT current_user",
      "COMMIT",
    ],
  );
  assert.deepEqual(client.calls[3]?.params, ["1500"]);
});

test("queryAs and withUserContext keep setting user and workspace context", async () => {
  const client = createFakeClient(async () => createEmptyResult());
  let provisionCalls = 0;

  const facade = createDbFacade({
    query: async () => createEmptyResult(),
    getPool: () => ({
      connect: async () => client,
      end: async () => undefined,
      on: () => ({}) as never,
      once: () => ({}) as never,
      removeListener: () => ({}) as never,
      query: async () => createEmptyResult(),
    } as never),
    ensureUserProvisioned: async () => {
      provisionCalls += 1;
    },
    ensureTrustedIdentityProvisioned: async () => {
      throw new Error("trusted provisioning should not be used");
    },
  });

  await facade.queryAs("user-1", "workspace-1", "SELECT 1", []);
  await facade.withUserContext("user-1", "workspace-1", async (queryFn) => {
    await queryFn("SELECT 2", []);
  });

  assert.equal(provisionCalls, 2);
  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 1",
      "COMMIT",
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 2",
      "COMMIT",
    ],
  );
});

test("ensureProvisionedIdentity verifies state after expected race conflict", async () => {
  resetProvisioningCachesForTests();

  const provisioningClient = createFakeClient(async (text) => {
    if (text === "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2") {
      return createEmptyResult();
    }
    if (text === "SELECT provision_personal_workspace_for_current_user()") {
      const error = new Error("duplicate workspace member") as Error & {
        code?: string;
        constraint?: string;
      };
      error.code = "23505";
      error.constraint = "workspace_members_pkey";
      throw error;
    }
    return createEmptyResult();
  });

  const verificationClient = createFakeClient(async (text) => {
    if (
      text === "SELECT 1 FROM users WHERE user_id = $1"
      || text === "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2"
      || text === "SELECT 1 FROM workspace_settings WHERE workspace_id = $1"
      || text === "SELECT 1 FROM user_settings WHERE user_id = $1"
    ) {
      return createResultWithRows(1);
    }
    return createEmptyResult();
  });

  let connectCount = 0;
  const pool = {
    connect: async (): Promise<typeof provisioningClient> => {
      connectCount += 1;
      return connectCount === 1 ? provisioningClient : verificationClient;
    },
  };

  await ensureProvisionedIdentity(
    createIdentity("user-race"),
    "user-race",
    {
      pool,
      getInitialLocale: async () => "en",
      getInitialTimezone: async () => null,
      upsertIdentity: async () => undefined,
      ensureUserSettings: async () => undefined,
    },
  );

  assert.deepEqual(
    provisioningClient.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      "SELECT provision_personal_workspace_for_current_user()",
      "ROLLBACK",
    ],
  );
  assert.deepEqual(
    verificationClient.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 1 FROM users WHERE user_id = $1",
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
      "SELECT 1 FROM user_settings WHERE user_id = $1",
      "COMMIT",
    ],
  );
});

test("ensureProvisionedIdentity uses browser timezone when provisioning a personal workspace", async () => {
  resetProvisioningCachesForTests();

  const provisioningClient = createFakeClient(async (text) => {
    if (text === "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2") {
      return createEmptyResult();
    }
    if (text === "SELECT 1 FROM workspace_settings WHERE workspace_id = $1") {
      return createResultWithRows(1);
    }
    return createEmptyResult();
  });

  await ensureProvisionedIdentity(
    createIdentity("user-timezone"),
    "user-timezone",
    {
      pool: { connect: async () => provisioningClient },
      getInitialLocale: async () => "en",
      getInitialTimezone: async () => "Europe/Madrid",
      upsertIdentity: async () => undefined,
      ensureUserSettings: async () => undefined,
    },
  );

  assert.deepEqual(
    provisioningClient.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      "SELECT provision_personal_workspace_for_current_user($1)",
      "SELECT 1 FROM workspace_settings WHERE workspace_id = $1",
      "COMMIT",
    ],
  );
  assert.deepEqual(provisioningClient.calls[4]?.params, ["Europe/Madrid"]);
});

test("trusted identity wrappers do not use session-backed provisioning", async () => {
  const client = createFakeClient(async () => createEmptyResult());
  let trustedProvisionCalls = 0;

  const facade = createDbFacade({
    query: async () => createEmptyResult(),
    getPool: () => ({
      connect: async () => client,
      end: async () => undefined,
      on: () => ({}) as never,
      once: () => ({}) as never,
      removeListener: () => ({}) as never,
      query: async () => createEmptyResult(),
    } as never),
    ensureUserProvisioned: async () => {
      throw new Error("session provisioning should not be used");
    },
    ensureTrustedIdentityProvisioned: async () => {
      trustedProvisionCalls += 1;
    },
  });

  const identity = createIdentity("trusted-user");

  await facade.queryAsTrustedIdentity(identity, "workspace-1", "SELECT 1", []);
  await facade.withRestrictedTrustedIdentityContext(identity, "workspace-1", 500, async (queryFn) => {
    await queryFn("SELECT 2", []);
  });

  assert.equal(trustedProvisionCalls, 2);
  assert.deepEqual(
    client.calls.map((call) => call.text),
    [
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT 1",
      "COMMIT",
      "BEGIN",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT set_config('app.workspace_id', $1, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      "SET LOCAL ROLE api_sql_executor",
      "SELECT 2",
      "COMMIT",
    ],
  );
});
