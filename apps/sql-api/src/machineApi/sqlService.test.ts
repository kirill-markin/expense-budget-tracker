import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import { SqlPolicyError } from "@expense-budget-tracker/agent-shared/sql-policy";
import { createQueryResult } from "../handlerTestUtils.js";
import { runSql } from "./sqlService.js";
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
  loadOpenApiDocument: overrides.loadOpenApiDocument ?? (() => ({})),
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

test("runSql rejects function-only SQL before executing restricted queries", async (): Promise<void> => {
  let restrictedContextCalled = false;
  const dependencies = createDependencies({
    withRestrictedTrustedIdentityContext: async () => {
      restrictedContextCalled = true;
      throw new Error("restricted context should not run");
    },
  });

  await assert.rejects(
    () => runSql(dependencies, createAuthenticatedContext(), "user-1", "SELECT delete_workspace_for_current_user('user-1')"),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );

  assert.equal(restrictedContextCalled, false);
});

test("runSql still executes allowed direct relation queries", async (): Promise<void> => {
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
          rows: [{ account_id: "a-main-usd" }],
        }) as QueryResult);
    },
  });

  const result = await runSql(
    dependencies,
    createAuthenticatedContext(),
    "user-1",
    "SELECT account_id FROM ledger_entries LIMIT 1",
  );
  const workspace = (result?.workspace ?? null) as WorkspaceSummary | null;

  assert.equal(restrictedContextCalled, true);
  assert.equal(workspace?.workspaceId, "user-1");
});
