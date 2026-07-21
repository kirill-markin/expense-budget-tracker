import type {
  SqlIdentifierToken,
  SqlSourceRange,
  SqlStringToken,
} from "./sql-policy-lexer.js";
import type { SqlTokenCursor } from "./sql-policy-parser-kernel.js";

export type SqlTypeModifierNode = Readonly<{
  kind: "identifier" | "numeric" | "string";
  normalizedValue: string;
  range: SqlSourceRange;
  sql: string;
  valueRange: SqlSourceRange;
}>;

export type SqlArrayBoundNode = Readonly<{
  notation: "array" | "brackets";
  range: SqlSourceRange;
  size: string | null;
}>;

export type SqlIntervalField =
  | "day"
  | "hour"
  | "minute"
  | "month"
  | "second"
  | "year";

export type SqlIntervalQualifierNode = Readonly<{
  endField: SqlIntervalField;
  range: SqlSourceRange;
  secondPrecision: string | null;
  sql: string;
  startField: SqlIntervalField;
}>;

export type SqlTimeZoneNode = Readonly<{
  kind: "with" | "without";
  range: SqlSourceRange;
}>;

export type SqlTypeNameForm =
  | "bigint"
  | "bit"
  | "boolean"
  | "character"
  | "decimal"
  | "double_precision"
  | "float"
  | "generic"
  | "integer"
  | "interval"
  | "json"
  | "real"
  | "smallint"
  | "time"
  | "timestamp";

export type SqlTypeNameNode = Readonly<{
  arrayBounds: ReadonlyArray<SqlArrayBoundNode>;
  form: SqlTypeNameForm;
  intervalQualifier: SqlIntervalQualifierNode | null;
  modifiers: ReadonlyArray<SqlTypeModifierNode>;
  nameParts: ReadonlyArray<SqlIdentifierToken>;
  nameRange: SqlSourceRange;
  range: SqlSourceRange;
  setOf: boolean;
  sql: string;
  timeZone: SqlTimeZoneNode | null;
}>;

export type SqlTypedConstantNode = Readonly<{
  intervalQualifier: SqlIntervalQualifierNode | null;
  range: SqlSourceRange;
  sql: string;
  typeName: SqlTypeNameNode;
  value: SqlStringToken;
}>;

export type SqlTypedConstantParseAttempt =
  | Readonly<{
    cursor: SqlTokenCursor;
    matched: false;
  }>
  | Readonly<{
    cursor: SqlTokenCursor;
    matched: true;
    node: SqlTypedConstantNode;
  }>;

export type SqlTypeParseResult<Node> = Readonly<{
  cursor: SqlTokenCursor;
  node: Node;
}>;
