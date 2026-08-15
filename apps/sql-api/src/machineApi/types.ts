import type { AgentSchemaHints } from "@expense-budget-tracker/agent-shared";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { AllowedRelationName } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  ensureTrustedIdentityProvisioned,
  queryAsTrustedIdentity,
  queryAsTrustedIdentityBeforeDeadline,
  resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline,
  type UserIdentity,
  withReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
} from "../db.js";

export type TrustedIdentityContext = Readonly<{
  identity: UserIdentity;
}>;

export type AuthenticatedContext = TrustedIdentityContext & Readonly<{
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}>;

export type MachineApiDependencies = Readonly<{
  ensureTrustedIdentityProvisioned: typeof ensureTrustedIdentityProvisioned;
  queryAsTrustedIdentity: typeof queryAsTrustedIdentity;
  queryAsTrustedIdentityBeforeDeadline: typeof queryAsTrustedIdentityBeforeDeadline;
  resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: typeof resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline;
  withReadOnlyRestrictedTrustedIdentityContext: typeof withReadOnlyRestrictedTrustedIdentityContext;
  withRestrictedTrustedIdentityContext: typeof withRestrictedTrustedIdentityContext;
}>;

export type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

export type PgError = Error & Readonly<{
  code?: string;
}>;

export type EntityHint = Readonly<{
  name: AllowedRelationName;
  summary: string;
}>;

export type EntityHints = Readonly<{
  primary: EntityHint;
  related: ReadonlyArray<EntityHint>;
}>;

export type SchemaColumnRow = Readonly<{
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}>;

export type SchemaColumn = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}>;

export type SchemaRelation = Readonly<{
  name: AllowedRelationName;
  columns: ReadonlyArray<SchemaColumn>;
  hints?: AgentSchemaHints;
}>;

export type JsonBody = Readonly<Record<string, unknown>>;

export type MachineRouteContext = Readonly<{
  event: APIGatewayProxyEvent;
  dependencies: MachineApiDependencies;
  authenticated: AuthenticatedContext;
  apiBaseUrl: string;
  authBaseUrl: string;
}>;
