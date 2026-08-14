import type {
  ValidatedExpenseSql,
  ValidatedReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  queryAsExistingTrustedIdentity,
  queryAsExistingTrustedWorkspace,
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
  queryAsExistingTrustedIdentity: typeof queryAsExistingTrustedIdentity;
  queryAsExistingTrustedWorkspace: typeof queryAsExistingTrustedWorkspace;
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext: typeof withNonProvisioningReadOnlyRestrictedTrustedIdentityContext;
  withRestrictedTrustedIdentityContext: typeof withRestrictedTrustedIdentityContext;
}>;

export type McpDataServices = Readonly<{
  listWorkspaces: (identity: UserIdentity) => Promise<ReadonlyArray<WorkspaceSummary>>;
  getWorkspace: (identity: UserIdentity, workspaceId: string) => Promise<WorkspaceSummary | null>;
  loadAllowedSchemaForWorkspace: (identity: UserIdentity, workspaceId: string) => Promise<ReadonlyArray<SchemaRelation>>;
  runReadOnlySql: (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedReadOnlyExpenseSql,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
  runSql: (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedExpenseSql,
  ) => Promise<Readonly<Record<string, unknown>> | null>;
}>;

export const createMcpDataServices = (
  dependencies: McpDataDependencies,
): McpDataServices => {
  const listWorkspaces = (identity: UserIdentity): Promise<ReadonlyArray<WorkspaceSummary>> =>
    listWorkspacesWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedIdentity(identity, text, params),
      identity,
    );

  const getWorkspace = (
    identity: UserIdentity,
    workspaceId: string,
  ): Promise<WorkspaceSummary | null> =>
    getWorkspaceWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedIdentity(identity, text, params),
      identity,
      workspaceId,
    );

  const loadAllowedSchemaForWorkspace = (
    identity: UserIdentity,
    workspaceId: string,
  ): Promise<ReadonlyArray<SchemaRelation>> =>
    loadAllowedSchemaWithQuery(
      (text, params) => dependencies.queryAsExistingTrustedWorkspace(
        identity,
        workspaceId,
        text,
        params,
      ),
    );

  const runReadOnlySql = (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedReadOnlyExpenseSql,
  ): Promise<Readonly<Record<string, unknown>> | null> =>
    runReadOnlySqlWithServices(
      authenticated,
      workspaceId,
      validated,
      getWorkspace,
      dependencies.withNonProvisioningReadOnlyRestrictedTrustedIdentityContext,
    );

  const runSql = (
    authenticated: TrustedIdentityContext,
    workspaceId: string,
    validated: ValidatedExpenseSql,
  ): Promise<Readonly<Record<string, unknown>> | null> =>
    runSqlWithServices(
      authenticated,
      workspaceId,
      validated,
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
  queryAsExistingTrustedIdentity,
  queryAsExistingTrustedWorkspace,
  withNonProvisioningReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
});
