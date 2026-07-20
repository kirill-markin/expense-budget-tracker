import type { SqlSourceRange } from "./sql-policy-lexer.js";

export type SqlPolicyParserErrorCode =
  | "internal_invariant"
  | "invalid_configuration"
  | "invalid_delimiter"
  | "invalid_numeric"
  | "invalid_type_modifier"
  | "invalid_type_name"
  | "invalid_typed_constant"
  | "limit_complexity"
  | "limit_nesting"
  | "limit_source_length"
  | "limit_tokens"
  | "unexpected_token";

export class SqlPolicyParserError extends Error {
  readonly code: SqlPolicyParserErrorCode;
  readonly range: SqlSourceRange;

  constructor(
    code: SqlPolicyParserErrorCode,
    message: string,
    range: SqlSourceRange,
  ) {
    super(message);
    this.code = code;
    this.range = range;
  }
}

export const throwSqlPolicyParserError = (
  code: SqlPolicyParserErrorCode,
  message: string,
  range: SqlSourceRange,
): never => {
  throw new SqlPolicyParserError(code, message, range);
};

export const emptySqlSourceRange = (offset: number): SqlSourceRange => ({
  start: offset,
  end: offset,
});
