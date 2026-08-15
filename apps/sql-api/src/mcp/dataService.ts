import type {
  SqlExecutionDeadline,
  ValidatedExpenseSql,
  ValidatedReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  queryAsExistingTrustedIdentityBeforeDeadline,
  queryAsExistingTrustedWorkspaceBeforeDeadline,
  type UserIdentity,
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
} from "../db.js";
import { loadAllowedSchemaWithQuery } from "../machineApi/schemaService.js";
import {
  runReadOnlySqlWithServices,
  runSqlWithServices,
} from "../machineApi/sqlService.js";
import type {
  SchemaRelation,
  TrustedIdentityContext,
  WorkspaceSummary,
} from "../machineApi/types.js";
import {
  getWorkspaceWithQuery,
  listWorkspacesWithQuery,
} from "../machineApi/workspaceService.js";

export type McpDataDependencies = Readonly<{
  queryAsExistingTrustedIdentityBeforeDeadline: typeof queryAsExistingTrustedIdentityBeforeDeadline;
  queryAsExistingTrustedWorkspaceBeforeDeadline: typeof queryAsExistingTrustedWorkspaceBeforeDeadline;
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext: typeof withNonProvisioningReadOnlyRestrictedTrustedIdentityContext;
  withRestrictedTrustedIdentityContext: typeof withRestrictedTrustedIdentityContext;
}>;

export type McpDataServices = Readonly<{
  listWorkspaces: (
    identity: UserIdentity,
    deadline: SqlExecutionDeadline,
  ) => Promise<ReadonlyArray<WorkspaceSummary>>;
  getWorkspace: (
    identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
  ) => Promise<WorkspaceSummary | null>;
  loadAllowedSchemaForWorkspace: (
    identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
  ) => Promise<ReadonlyArray<SchemaRelation>>;
  runReadOnlySql: (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedReadOnlyExpenseSql,
    deadline: SqlExecutionDeadline,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
  runSql: (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedExpenseSql,
    deadline: SqlExecutionDeadline,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
}>;

export const createMcpDataServices = (
  dependencies: McpDataDependencies,
): McpDataServices => {
  const listWorkspaces = (
    identity: UserIdentity,
    deadline: SqlExecutionDeadline,
  ): Promise<ReadonlyArray<WorkspaceSummary>> =>
    listWorkspacesWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedIdentityBeforeDeadline(
        identity,
        text,
        params,
        deadline,
      ),
      identity,
    );

  const getWorkspace = (
    identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
  ): Promise<WorkspaceSummary | null> =>
    getWorkspaceWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedIdentityBeforeDeadline(
        identity,
        text,
        params,
        deadline,
      ),
      identity,
      workspaceId,
    );

  const loadAllowedSchemaForWorkspace = (
    identity: UserIdentity,
    workspaceId: string,
    deadline: SqlExecutionDeadline,
  ): Promise<ReadonlyArray<SchemaRelation>> =>
    loadAllowedSchemaWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedWorkspaceBeforeDeadline(
        identity,
        workspaceId,
        text,
        params,
        deadline,
      ),
    );

  const runReadOnlySql = (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedReadOnlyExpenseSql,
    deadline: SqlExecutionDeadline,
  ): Promise<Readonly<Record<string, unknown>> | null> =>
    runReadOnlySqlWithServices(
      authenticated,
      workspaceId,
      validated,
      deadline,
      getWorkspace,
      dependencies.withNonProvisioningReadOnlyRestrictedTrustedIdentityContext,
    );

  const runSql = (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedExpenseSql,
    deadline: SqlExecutionDeadline,
  ): Promise<Readonly<Record<string, unknown>> | null> =>
    runSqlWithServices(
      authenticated,
      workspaceId,
      validated,
      deadline,
      getWorkspace,
      dependencies.withRestrictedTrustedIdentityContext,
    );

  return {
    listWorkspaces,
    getWorkspace,
    loadAllowedSchemaForWorkspace,
    runReadOnlySql,
    runSql,
  };
};

export const mcpDataServices = createMcpDataServices({
  queryAsExistingTrustedIdentityBeforeDeadline,
  queryAsExistingTrustedWorkspaceBeforeDeadline,
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
});
