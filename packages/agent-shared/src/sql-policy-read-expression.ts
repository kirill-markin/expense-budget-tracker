import type { SqlSourceRange } from "./sql-policy-lexer.js";
import type {
  SqlExpressionMetadata,
  SqlExpressionSyntaxContext,
  SqlQueryContext,
} from "./sql-policy-read-model.js";
import type { SqlReadCursor } from "./sql-policy-read-state.js";

export type SqlExpressionEnvironment = Readonly<{
  context: SqlQueryContext;
  queryId: number;
  syntaxContext: SqlExpressionSyntaxContext;
}>;

export type SqlExpressionResult = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadata;
  range: SqlSourceRange;
}>;

export type SqlExpressionListResult = Readonly<{
  count: number;
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadata;
  range: SqlSourceRange;
}>;

/** Reads an expression from a cursor already bounded to its exact token span. */
export type SqlExpressionReader<TResult extends SqlExpressionResult> = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
) => TResult;

/**
 * Reads one complete expression prefix without requiring a guessed end bound.
 * The returned range and metadata describe only that expression. The returned
 * cursor keeps the input end bound, points at the first unconsumed token, and
 * preserves all cumulative work charged while reading the expression.
 */
export type SqlExpressionPrefixReader = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
) => SqlExpressionResult;
