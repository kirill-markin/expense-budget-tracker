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

export type SqlExpressionReader<TResult extends SqlExpressionResult> = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
) => TResult;
