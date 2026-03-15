import type { APIGatewayProxyEvent } from "aws-lambda";
import type { AllowedRelationName } from "@expense-budget-tracker/agent-shared/sql-policy";
import { ensureTrustedIdentityProvisioned, queryAsTrustedIdentity, type UserIdentity, withRestrictedTrustedIdentityContext } from "../db.js";
import { loadOpenApiDocument } from "../openapi.js";

export type AuthenticatedContext = Readonly<{
  identity: UserIdentity;
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}>;

export type MachineApiDependencies = Readonly<{
  ensureTrustedIdentityProvisioned: typeof ensureTrustedIdentityProvisioned;
  loadOpenApiDocument: typeof loadOpenApiDocument;
  queryAsTrustedIdentity: typeof queryAsTrustedIdentity;
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
}>;

export type JsonBody = Readonly<Record<string, unknown>>;

export type MachineRouteContext = Readonly<{
  event: APIGatewayProxyEvent;
  dependencies: MachineApiDependencies;
  authenticated: AuthenticatedContext;
  apiBaseUrl: string;
  authBaseUrl: string;
}>;
