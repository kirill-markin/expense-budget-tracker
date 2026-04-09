import { getAgentSchemaHints } from "@expense-budget-tracker/agent-shared";
import { getAllowedRelationNames, type AllowedRelationName } from "@expense-budget-tracker/agent-shared/sql-policy";
import { resolveOrCreateWorkspaceForTrustedIdentity, type UserIdentity } from "../db.js";
import type { MachineApiDependencies, SchemaColumn, SchemaColumnRow, SchemaRelation } from "./types.js";

export const ALLOWED_RELATION_NAMES = getAllowedRelationNames();

export const loadAllowedSchemaWithResolver = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
  resolveWorkspace: typeof resolveOrCreateWorkspaceForTrustedIdentity,
): Promise<ReadonlyArray<SchemaRelation>> => {
  const contextWorkspace = await resolveWorkspace(identity);
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    contextWorkspace.workspaceId,
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [ALLOWED_RELATION_NAMES],
  );

  const grouped = new Map<AllowedRelationName, Array<SchemaColumn>>();
  for (const relationName of ALLOWED_RELATION_NAMES) {
    grouped.set(relationName, []);
  }

  for (const row of result.rows) {
    const typedRow = row as SchemaColumnRow;
    const relationName = typedRow.table_name as AllowedRelationName;
    if (!grouped.has(relationName)) {
      continue;
    }

    const columns = grouped.get(relationName);
    if (columns === undefined) {
      throw new Error(`Missing schema relation bucket for ${relationName}`);
    }

    const normalizedType = typedRow.data_type === "USER-DEFINED"
      ? typedRow.udt_name
      : typedRow.data_type;

    columns.push({
      name: typedRow.column_name,
      type: normalizedType,
      nullable: typedRow.is_nullable === "YES",
      defaultValue: typedRow.column_default,
    });
  }

  return ALLOWED_RELATION_NAMES.map((name) => {
    const columns = grouped.get(name);
    if (columns === undefined) {
      throw new Error(`Missing schema relation ${name}`);
    }
    const hints = getAgentSchemaHints(name);

    return {
      name,
      columns,
      ...(hints === undefined ? {} : { hints }),
    };
  });
};

export const loadAllowedSchema = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
): Promise<ReadonlyArray<SchemaRelation>> =>
  loadAllowedSchemaWithResolver(
    dependencies,
    identity,
    resolveOrCreateWorkspaceForTrustedIdentity,
  );
