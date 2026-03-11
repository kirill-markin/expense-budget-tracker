/**
 * Safe schema introspection for agent clients.
 *
 * Returns only columns from relations allowed by the SQL policy.
 */
import { queryAsTrustedIdentity } from "@/server/db";
import { type UserIdentity } from "@/server/users";
import { getAllowedRelationNames, type AllowedRelationName } from "@/server/sql/core";

type SchemaColumnRow = Readonly<{
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}>;

type SchemaColumn = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}>;

export type SchemaRelation = Readonly<{
  name: AllowedRelationName;
  columns: ReadonlyArray<SchemaColumn>;
}>;

const ALLOWED_RELATIONS = getAllowedRelationNames();

export const getAllowedSchemaRelations = async (
  identity: UserIdentity,
): Promise<ReadonlyArray<SchemaRelation>> => {
  const result = await queryAsTrustedIdentity(
    identity,
    identity.userId,
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [ALLOWED_RELATIONS],
  );

  const grouped = new Map<AllowedRelationName, Array<SchemaColumn>>();
  for (const relationName of ALLOWED_RELATIONS) {
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

  return ALLOWED_RELATIONS.map((name) => {
    const columns = grouped.get(name);
    if (columns === undefined) {
      throw new Error(`Missing schema relation ${name}`);
    }
    return {
      name,
      columns,
    };
  });
};
