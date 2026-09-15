import { type Pool, type QueryResult } from "pg";

import {
  runStatementWithContext,
  runStatementWithReadOnlyContext,
  runWithContext,
  runWithReadOnlyContext,
  type QueryFn,
  type RestrictedDbRole,
} from "@/server/db/contextRunner";
import { type UserIdentity } from "@/server/users";

type ContextOptions = Readonly<{
  userId: string;
  workspaceId: string;
  statementTimeoutMs: number | null;
  restrictedRole: RestrictedDbRole | null;
}>;

type DbFacadeDependencies = Readonly<{
  query: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;
  getPool: () => Pool;
  ensureUserProvisioned: (userId: string, workspaceId: string) => Promise<void>;
  ensureTrustedIdentityProvisioned: (identity: UserIdentity, workspaceId: string) => Promise<void>;
}>;

type DbFacade = Readonly<{
  query: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;
  getPool: () => Pool;
  ensureUserProvisioned: (userId: string, workspaceId: string) => Promise<void>;
  ensureTrustedIdentityProvisioned: (identity: UserIdentity, workspaceId: string) => Promise<void>;
  queryAs: (userId: string, workspaceId: string, text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;
  queryAsTrustedIdentity: (identity: UserIdentity, workspaceId: string, text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;
  queryAsExistingWorkspace: (userId: string, workspaceId: string, text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;
  withUserContext: <T>(userId: string, workspaceId: string, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
  withUserOnlyContext: <T>(userId: string, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
  withReadOnlyRestrictedUserContext: <T>(userId: string, workspaceId: string, statementTimeoutMs: number, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
  withRestrictedTrustedIdentityContext: <T>(identity: UserIdentity, workspaceId: string, statementTimeoutMs: number, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
}>;

const runForUser = async <T>(
  dependencies: DbFacadeDependencies,
  userId: string,
  workspaceId: string,
  options: ContextOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await dependencies.ensureUserProvisioned(userId, workspaceId);
  return runWithContext(dependencies.getPool(), options, callback);
};

const runForTrustedIdentity = async <T>(
  dependencies: DbFacadeDependencies,
  identity: UserIdentity,
  workspaceId: string,
  options: ContextOptions,
  callback: (queryFn: QueryFn) => Promise<T>,
): Promise<T> => {
  await dependencies.ensureTrustedIdentityProvisioned(identity, workspaceId);
  return runWithContext(dependencies.getPool(), options, callback);
};

export const createDbFacade = (dependencies: DbFacadeDependencies): DbFacade => ({
  query: dependencies.query,
  getPool: dependencies.getPool,
  ensureUserProvisioned: dependencies.ensureUserProvisioned,
  ensureTrustedIdentityProvisioned: dependencies.ensureTrustedIdentityProvisioned,
  queryAs: async (
    userId,
    workspaceId,
    text,
    params,
  ): Promise<QueryResult> => {
    await dependencies.ensureUserProvisioned(userId, workspaceId);
    return runStatementWithContext(
      dependencies.getPool(),
      {
        userId,
        workspaceId,
        statementTimeoutMs: null,
        restrictedRole: null,
      },
      text,
      params,
    );
  },
  queryAsTrustedIdentity: async (
    identity,
    workspaceId,
    text,
    params,
  ): Promise<QueryResult> => {
    await dependencies.ensureTrustedIdentityProvisioned(identity, workspaceId);
    return runStatementWithContext(
      dependencies.getPool(),
      {
        userId: identity.userId,
        workspaceId,
        statementTimeoutMs: null,
        restrictedRole: null,
      },
      text,
      params,
    );
  },
  /**
   * Read existing workspace-scoped data in a read-only transaction under the
   * caller's RLS context.
   *
   * Deliberately skips ensureUserProvisioned: that path upserts the users row,
   * inserts a missing workspace_settings row for the given workspace, and
   * ensures user_settings, none of which a read-only call such as a chat
   * discovery tool may do. The caller must have already established membership;
   * RLS still confines every row this can return.
   */
  queryAsExistingWorkspace: async (
    userId,
    workspaceId,
    text,
    params,
  ): Promise<QueryResult> =>
    runStatementWithReadOnlyContext(
      dependencies.getPool(),
      {
        userId,
        workspaceId,
        statementTimeoutMs: null,
        restrictedRole: null,
      },
      text,
      params,
    ),
  withUserContext: async <T>(
    userId: string,
    workspaceId: string,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> =>
    runForUser(
      dependencies,
      userId,
      workspaceId,
      {
        userId,
        workspaceId,
        statementTimeoutMs: null,
        restrictedRole: null,
      },
      callback,
    ),
  /**
   * Run statements against strictly user-scoped tables, whose RLS policies key
   * on app.user_id alone.
   *
   * Deliberately skips ensureUserProvisioned: that path requires membership in
   * a workspace and writes the users and settings rows, while user-scoped
   * counters such as chat_turn_rate_events have no workspace and must never
   * trigger those writes. app.workspace_id is set to an empty string so no
   * workspace-scoped policy can match inside this context.
   */
  withUserOnlyContext: async <T>(
    userId: string,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> =>
    runWithContext(
      dependencies.getPool(),
      {
        userId,
        workspaceId: "",
        statementTimeoutMs: null,
        restrictedRole: null,
      },
      callback,
    ),
  /**
   * Run read-only user SQL in one stable-snapshot transaction under the
   * least-privilege reader role, the shape
   * apps/sql-api/src/db.ts withReadOnlyRestrictedTrustedIdentityContext uses.
   * The transaction mode and the role are a second layer behind statement
   * validation: neither depends on the SQL having been validated at all.
   */
  withReadOnlyRestrictedUserContext: async <T>(
    userId: string,
    workspaceId: string,
    statementTimeoutMs: number,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> => {
    await dependencies.ensureUserProvisioned(userId, workspaceId);
    return runWithReadOnlyContext(
      dependencies.getPool(),
      {
        userId,
        workspaceId,
        statementTimeoutMs,
        restrictedRole: "api_sql_reader",
      },
      callback,
    );
  },
  withRestrictedTrustedIdentityContext: async <T>(
    identity: UserIdentity,
    workspaceId: string,
    statementTimeoutMs: number,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> =>
    runForTrustedIdentity(
      dependencies,
      identity,
      workspaceId,
      {
        userId: identity.userId,
        workspaceId,
        statementTimeoutMs,
        restrictedRole: "api_sql_executor",
      },
      callback,
    ),
});
