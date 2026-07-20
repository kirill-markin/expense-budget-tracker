import type { SqlIdentifierToken } from "./sql-policy-lexer.js";
import type { SqlParserToken } from "./sql-policy-parser-kernel.js";
import type { SqlIntervalField } from "./sql-policy-type-model.js";

const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "system_user",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

const COL_NAME_KEYWORDS: ReadonlySet<string> = new Set([
  "between",
  "bigint",
  "bit",
  "boolean",
  "char",
  "character",
  "coalesce",
  "dec",
  "decimal",
  "exists",
  "extract",
  "float",
  "greatest",
  "grouping",
  "inout",
  "int",
  "integer",
  "interval",
  "json",
  "json_array",
  "json_arrayagg",
  "json_exists",
  "json_object",
  "json_objectagg",
  "json_query",
  "json_scalar",
  "json_serialize",
  "json_table",
  "json_value",
  "least",
  "merge_action",
  "national",
  "nchar",
  "none",
  "normalize",
  "nullif",
  "numeric",
  "out",
  "overlay",
  "position",
  "precision",
  "real",
  "row",
  "setof",
  "smallint",
  "substring",
  "time",
  "timestamp",
  "treat",
  "trim",
  "values",
  "varchar",
  "xmlattributes",
  "xmlconcat",
  "xmlelement",
  "xmlexists",
  "xmlforest",
  "xmlnamespaces",
  "xmlparse",
  "xmlpi",
  "xmlroot",
  "xmlserialize",
  "xmltable",
]);

const TYPE_FUNC_NAME_KEYWORDS: ReadonlySet<string> = new Set([
  "authorization",
  "binary",
  "collation",
  "concurrently",
  "cross",
  "current_schema",
  "freeze",
  "full",
  "ilike",
  "inner",
  "is",
  "isnull",
  "join",
  "left",
  "like",
  "natural",
  "notnull",
  "outer",
  "overlaps",
  "right",
  "similar",
  "tablesample",
  "verbose",
]);

const TYPE_FUNCTION_DISALLOWED_KEYWORDS: ReadonlySet<string> = new Set([
  ...RESERVED_KEYWORDS,
  ...COL_NAME_KEYWORDS,
]);

export const POSTGRESQL_INTERVAL_FIELDS: ReadonlySet<string> = new Set([
  "day",
  "hour",
  "minute",
  "month",
  "second",
  "year",
]);

export const POSTGRESQL_INTERVAL_FIELD_PAIRS: ReadonlySet<string> = new Set([
  "day:hour",
  "day:minute",
  "day:second",
  "hour:minute",
  "hour:second",
  "minute:second",
  "year:month",
]);

export const postgreSqlTokenWord = (
  token: SqlParserToken | undefined,
): string | null =>
  token?.kind === "identifier" && !token.quoted
    ? token.untruncatedNormalized
    : null;

export const isPostgreSqlColId = (
  token: SqlIdentifierToken,
): boolean =>
  token.quoted
  || (
    !RESERVED_KEYWORDS.has(token.untruncatedNormalized)
    && !TYPE_FUNC_NAME_KEYWORDS.has(token.untruncatedNormalized)
  );

export const isPostgreSqlTypeModifierIdentifier = (
  token: SqlIdentifierToken,
): boolean => isPostgreSqlColId(token);

export const isPostgreSqlTypeFunctionName = (
  token: SqlIdentifierToken,
): boolean =>
  token.quoted
  || !TYPE_FUNCTION_DISALLOWED_KEYWORDS.has(token.untruncatedNormalized);

export const isPostgreSqlIntervalField = (
  value: string,
): value is SqlIntervalField => POSTGRESQL_INTERVAL_FIELDS.has(value);
