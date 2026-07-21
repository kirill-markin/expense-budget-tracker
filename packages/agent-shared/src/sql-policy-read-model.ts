import type {
  SqlIdentifierToken,
  SqlSourceRange,
} from "./sql-policy-lexer.js";
import type {
  SqlTypeNameNode,
  SqlTypedConstantNode,
} from "./sql-policy-type-model.js";

export type SqlQueryContext = "nested" | "root" | "root_cte";

export type SqlExpressionSyntaxContext = "cycle" | "expression" | "from";

export type SqlIdentifierPath = ReadonlyArray<SqlIdentifierToken>;

export type SqlCallNode = Readonly<{
  argumentsRange: SqlSourceRange;
  context: SqlQueryContext;
  path: SqlIdentifierPath;
  queryId: number;
  range: SqlSourceRange;
  syntaxContext: SqlExpressionSyntaxContext;
}>;

export type SqlNestedQueryKind =
  | "array"
  | "exists"
  | "expression"
  | "in"
  | "quantified";

export type SqlNestedQueryNode = Readonly<{
  bodyRange: SqlSourceRange;
  context: "nested";
  kind: SqlNestedQueryKind;
  parentQueryId: number;
  range: SqlSourceRange;
  startIndex: number;
  endIndex: number;
}>;

export type SqlTypeConstructNode =
  | Readonly<{
    context: SqlQueryContext;
    queryId: number;
    range: SqlSourceRange;
    syntax: "cast";
    typeName: SqlTypeNameNode;
  }>
  | Readonly<{
    context: SqlQueryContext;
    queryId: number;
    range: SqlSourceRange;
    syntax: "literal";
    typedConstant: SqlTypedConstantNode;
    typeName: SqlTypeNameNode;
  }>;

export type SqlExpressionMetadata = Readonly<{
  calls: ReadonlyArray<SqlCallNode>;
  nestedQueries: ReadonlyArray<SqlNestedQueryNode>;
  typeConstructs: ReadonlyArray<SqlTypeConstructNode>;
}>;
