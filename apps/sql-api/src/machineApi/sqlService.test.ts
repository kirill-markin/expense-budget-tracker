import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { createQueryResult } from "../handlerTestUtils.js";
import { getSqlPolicyInstructions, runSqlWithWorkspaceGetter } from "./sqlService.js";
import type {
  AuthenticatedContext,
  MachineApiDependencies,
  WorkspaceSummary,
} from "./types.js";

const createAuthenticatedContext = (): AuthenticatedContext => ({
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
  connectionId: "connection-1",
  label: "desktop",
  createdAt: "2026-04-01T00:00:00.000Z",
  lastUsedAt: null,
});

const createDependencies = (
  overrides: Partial<MachineApiDependencies> = {},
): MachineApiDependencies => ({
  ensureTrustedIdentityProvisioned: overrides.ensureTrustedIdentityProvisioned ?? (async () => undefined),
  queryAsTrustedIdentity: overrides.queryAsTrustedIdentity ?? (async () =>
    createQueryResult([{ workspace_id: "user-1", name: "Personal" }])),
  withRestrictedTrustedIdentityContext: overrides.withRestrictedTrustedIdentityContext ?? (async <T>(
    _identity: AuthenticatedContext["identity"],
    _workspaceId: string,
    _statementTimeoutMs: number,
    callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
  ): Promise<T> =>
    callback(async () =>
      ({
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
        rows: [],
      }) as QueryResult)),
});

const workspaceGetter = async (): Promise<WorkspaceSummary> => ({
  workspaceId: "user-1",
  name: "Personal",
});

test("runSql rejects function-only SQL before executing restricted queries", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT delete_workspace_for_current_user('user-1')",
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql rejects SELECT-only mutation targets before workspace or restricted database access", async (): Promise<void> => {
  let workspaceGetterCalled = false;
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "WITH deleted_rates AS (DELETE FROM fx_rates_raw WHERE base_currency = 'EUR' RETURNING *) SELECT * FROM deleted_rates",
      async (): Promise<WorkspaceSummary> => {
        workspaceGetterCalled = true;
        return workspaceGetter();
      },
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "read_only_relation_mutation_not_allowed"
      && getSqlPolicyInstructions(error, "https://api.example.com/v1")
        === "Relation fx_rates_raw is SELECT-only and cannot be targeted by DELETE in restricted SQL. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata.",
  );

  assert.equal(workspaceGetterCalled, false);
  assert.equal(restrictedContextCalled, false);
});

test("runSql rejects community public share relations before executing restricted queries", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT * FROM community.monthly_category_shares",
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "relation_not_allowed",
  );

  await assert.rejects(
    () => runSqlWithWorkspaceGetter(
      dependencies,
      createAuthenticatedContext(),
      "user-1",
      "SELECT * FROM community.read_public_monthly_category_share('token', '2025-01-01', '2025-12-01')",
      workspaceGetter,
    ),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql executes allowed aggregate relation queries with row metadata", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async <T>(
      _identity: AuthenticatedContext["identity"],
      _workspaceId: string,
      _statementTimeoutMs: number,
      callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>) => Promise<T>,
    ): Promise<T> => {
      restrictedContextCalled = true;
      return callback(async () =>
        ({
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{ balance: "123.45" }],
        }) as QueryResult);
    },
  });

  const result = await runSqlWithWorkspaceGetter(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    workspaceGetter,
  );
  const workspace = (result?.workspace ?? null) as WorkspaceSummary | null;
  const statements = (result?.statements ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const statement = statements[0];

  assert.equal(restrictedContextCalled, true);
  assert.equal(workspace?.workspaceId, "user-1");
  assert.equal(statement?.rowCount, 1);
  assert.equal(statement?.returnedRowCount, 1);
  assert.equal(statement?.totalRowCount, 1);
  assert.equal(statement?.truncated, false);
});
