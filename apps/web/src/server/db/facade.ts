import { type Pool, type QueryResult } from "pg";

import { runStatementWithContext, runWithContext, type QueryFn } from "@/server/db/contextRunner";
import { type UserIdentity } from "@/server/users";

type ContextOptions = Readonly<{
  userId: string;
  workspaceId: string;
  statementTimeoutMs: number | null;
  useRestrictedRole: boolean;
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
  withUserContext: <T>(userId: string, workspaceId: string, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
  withRestrictedUserContext: <T>(userId: string, workspaceId: string, statementTimeoutMs: number, callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;
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
        useRestrictedRole: false,
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
        useRestrictedRole: false,
      },
      text,
      params,
    );
  },
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
        useRestrictedRole: false,
      },
      callback,
    ),
  withRestrictedUserContext: async <T>(
    userId: string,
    workspaceId: string,
    statementTimeoutMs: number,
    callback: (queryFn: QueryFn) => Promise<T>,
  ): Promise<T> =>
    runForUser(
      dependencies,
      userId,
      workspaceId,
      {
        userId,
        workspaceId,
        statementTimeoutMs,
        useRestrictedRole: true,
      },
      callback,
    ),
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
        useRestrictedRole: true,
      },
      callback,
    ),
});
