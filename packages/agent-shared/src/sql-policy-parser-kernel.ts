import {
  lexSqlPolicyInfrastructure,
  type SqlCommentToken,
  type SqlLexedScript,
  type SqlNumericToken,
  type SqlPolicyToken,
  type SqlSourceRange,
  type SqlWhitespaceToken,
} from "./sql-policy-lexer.js";
import {
  emptySqlSourceRange,
  throwSqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";

export type SqlParserToken = Exclude<
  SqlPolicyToken,
  SqlCommentToken | SqlWhitespaceToken
>;

export type SqlParserLimits = Readonly<{
  maxSourceCodeUnits: number;
  maxTokens: number;
  maxNestingDepth: number;
  maxWorkUnits: number;
}>;

export const DEFAULT_SQL_PARSER_LIMITS: SqlParserLimits = {
  maxSourceCodeUnits: 1_000_000,
  maxTokens: 100_000,
  maxNestingDepth: 256,
  maxWorkUnits: 500_000,
};

export type SqlParserStatementSpan = Readonly<{
  range: SqlSourceRange;
  terminatorRange: SqlSourceRange | null;
  startIndex: number;
  endIndex: number;
}>;

export type SqlDelimiterIndex = Readonly<{
  matchingIndexes: ReadonlyMap<number, number>;
  scanSteps: number;
}>;

export type SqlParserKernel = Readonly<{
  sql: string;
  sourceTokens: ReadonlyArray<SqlPolicyToken>;
  tokens: ReadonlyArray<SqlParserToken>;
  statements: ReadonlyArray<SqlParserStatementSpan>;
  delimiters: SqlDelimiterIndex;
  limits: SqlParserLimits;
}>;

export type SqlTokenCursor = Readonly<{
  kernel: SqlParserKernel;
  index: number;
  endIndex: number;
  workUnits: number;
}>;

type OpenDelimiter = Readonly<{
  index: number;
  text: "(" | "[";
}>;

const isPositiveInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

const validateLimits = (limits: SqlParserLimits): void => {
  if (!isPositiveInteger(limits.maxSourceCodeUnits)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser maxSourceCodeUnits must be a positive safe integer; received ${String(limits.maxSourceCodeUnits)}`,
      emptySqlSourceRange(0),
    );
  }
  if (!isPositiveInteger(limits.maxTokens)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser maxTokens must be a positive safe integer; received ${String(limits.maxTokens)}`,
      emptySqlSourceRange(0),
    );
  }
  if (!isPositiveInteger(limits.maxNestingDepth)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser maxNestingDepth must be a positive safe integer; received ${String(limits.maxNestingDepth)}`,
      emptySqlSourceRange(0),
    );
  }
  if (!isPositiveInteger(limits.maxWorkUnits)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser maxWorkUnits must be a positive safe integer; received ${String(limits.maxWorkUnits)}`,
      emptySqlSourceRange(0),
    );
  }
};

const significantTokens = (
  lexed: SqlLexedScript,
): ReadonlyArray<SqlParserToken> =>
  lexed.tokens.filter(
    (token): token is SqlParserToken =>
      token.kind !== "comment" && token.kind !== "whitespace",
  );

const errorRangeAtIndex = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
  index: number,
): SqlSourceRange =>
  tokens[index]?.range ?? emptySqlSourceRange(sql.length);

const assertNumericTokensValid = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
): void => {
  for (const token of tokens) {
    if (token.kind !== "numeric" || token.valid) {
      continue;
    }
    const invalid = token as SqlNumericToken & Readonly<{ valid: false }>;
    return throwSqlPolicyParserError(
      "invalid_numeric",
      `Invalid PostgreSQL numeric token at offset ${String(token.range.start)}: ${invalid.diagnostic.message}`,
      token.range,
    );
  }
  void sql;
};

const expectedOpenDelimiter = (text: string): "(" | "[" | null => {
  if (text === ")") {
    return "(";
  }
  if (text === "]") {
    return "[";
  }
  return null;
};

const expectedCloseDelimiter = (text: "(" | "["): ")" | "]" =>
  text === "(" ? ")" : "]";

const sqlOpenDelimiterToken = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
  open: OpenDelimiter,
): SqlParserToken => {
  const token = tokens[open.index];
  if (token === undefined) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `SQL parser opening delimiter token ${String(open.index)} disappeared during delimiter matching`,
      errorRangeAtIndex(sql, tokens, open.index),
    );
  }
  return token;
};

const buildDelimiterIndex = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
  limits: SqlParserLimits,
): SqlDelimiterIndex => {
  const matchingIndexes = new Map<number, number>();
  const stack: Array<OpenDelimiter> = [];
  let scanSteps = 0;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        `SQL parser token ${String(index)} disappeared during delimiter indexing`,
        errorRangeAtIndex(sql, tokens, index),
      );
    }
    scanSteps++;
    if (scanSteps > limits.maxWorkUnits) {
      return throwSqlPolicyParserError(
        "limit_complexity",
        `SQL parser delimiter indexing exceeded maxWorkUnits=${String(limits.maxWorkUnits)} at token ${String(index)}`,
        token.range,
      );
    }

    if (token.text === ";") {
      const unclosed = stack.at(-1);
      if (unclosed !== undefined) {
        const openToken = sqlOpenDelimiterToken(sql, tokens, unclosed);
        return throwSqlPolicyParserError(
          "invalid_delimiter",
          `Expected ${expectedCloseDelimiter(unclosed.text)} before the statement terminator for delimiter at offset ${String(openToken.range.start)}`,
          openToken.range,
        );
      }
      continue;
    }

    if (token.text === "(" || token.text === "[") {
      if (stack.length + 1 > limits.maxNestingDepth) {
        return throwSqlPolicyParserError(
          "limit_nesting",
          `SQL parser nesting exceeds maxNestingDepth=${String(limits.maxNestingDepth)} at offset ${String(token.range.start)}`,
          token.range,
        );
      }
      stack.push({ index, text: token.text });
      continue;
    }

    const expectedOpen = expectedOpenDelimiter(token.text);
    if (expectedOpen === null) {
      continue;
    }
    const open = stack.pop();
    if (open === undefined) {
      return throwSqlPolicyParserError(
        "invalid_delimiter",
        `Unexpected ${token.text} at offset ${String(token.range.start)}; expected an opening ${expectedOpen}`,
        token.range,
      );
    }
    if (open.text !== expectedOpen) {
      const openToken = sqlOpenDelimiterToken(sql, tokens, open);
      return throwSqlPolicyParserError(
        "invalid_delimiter",
        `Unexpected ${token.text} at offset ${String(token.range.start)}; expected ${expectedCloseDelimiter(open.text)} for opening ${open.text} at offset ${String(openToken.range.start)}`,
        token.range,
      );
    }
    matchingIndexes.set(open.index, index);
    matchingIndexes.set(index, open.index);
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) {
    const openToken = sqlOpenDelimiterToken(sql, tokens, unclosed);
    return throwSqlPolicyParserError(
      "invalid_delimiter",
      `Expected ${expectedCloseDelimiter(unclosed.text)} for delimiter at offset ${String(openToken.range.start)}`,
      openToken.range,
    );
  }

  return { matchingIndexes, scanSteps };
};

const buildStatementSpans = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
  lexed: SqlLexedScript,
): ReadonlyArray<SqlParserStatementSpan> => {
  const tokenSpans: Array<Readonly<{
    startIndex: number;
    endIndex: number;
  }>> = [];
  let startIndex = 0;

  for (let index = 0; index <= tokens.length; index++) {
    const token = tokens[index];
    const atEnd = index === tokens.length;
    if (!atEnd && token?.text !== ";") {
      continue;
    }
    if (startIndex < index) {
      const first = tokens[startIndex];
      const last = tokens[index - 1];
      if (first === undefined || last === undefined) {
        return throwSqlPolicyParserError(
          "internal_invariant",
          `Cannot build SQL statement token span ${String(startIndex)}..${String(index)}`,
          errorRangeAtIndex(sql, tokens, startIndex),
        );
      }
      tokenSpans.push({ startIndex, endIndex: index });
    }
    startIndex = index + 1;
  }

  if (tokenSpans.length !== lexed.statements.length) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `SQL lexer produced ${String(lexed.statements.length)} statements but the parser kernel indexed ${String(tokenSpans.length)}`,
      emptySqlSourceRange(sql.length),
    );
  }
  return tokenSpans.map((span, index) => {
    const statement = lexed.statements[index];
    if (statement === undefined) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        `SQL lexer statement ${String(index)} disappeared during parser indexing`,
        emptySqlSourceRange(sql.length),
      );
    }
    return {
      ...span,
      range: statement.range,
      terminatorRange: statement.terminatorRange,
    };
  });
};

export const createSqlParserKernel = (
  sql: string,
  limits: SqlParserLimits,
): SqlParserKernel => {
  validateLimits(limits);
  if (sql.length > limits.maxSourceCodeUnits) {
    return throwSqlPolicyParserError(
      "limit_source_length",
      `SQL source length ${String(sql.length)} UTF-16 code units exceeds maxSourceCodeUnits=${String(limits.maxSourceCodeUnits)}; the first excess code unit is at offset ${String(limits.maxSourceCodeUnits)}`,
      {
        start: limits.maxSourceCodeUnits,
        end: limits.maxSourceCodeUnits + 1,
      },
    );
  }
  const lexed = lexSqlPolicyInfrastructure(sql);
  const tokens = significantTokens(lexed);
  if (tokens.length > limits.maxTokens) {
    const token = tokens[limits.maxTokens];
    return throwSqlPolicyParserError(
      "limit_tokens",
      `SQL parser token count ${String(tokens.length)} exceeds maxTokens=${String(limits.maxTokens)}`,
      token?.range ?? emptySqlSourceRange(sql.length),
    );
  }
  assertNumericTokensValid(sql, tokens);
  const delimiters = buildDelimiterIndex(sql, tokens, limits);
  return {
    sql,
    delimiters,
    limits,
    sourceTokens: lexed.tokens,
    statements: buildStatementSpans(sql, tokens, lexed),
    tokens,
  };
};

export const createSqlTokenCursor = (
  kernel: SqlParserKernel,
  startIndex: number,
  endIndex: number,
): SqlTokenCursor => {
  if (
    !Number.isSafeInteger(startIndex)
    || !Number.isSafeInteger(endIndex)
    || startIndex < 0
    || startIndex > endIndex
    || endIndex > kernel.tokens.length
  ) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Invalid SQL token cursor bounds ${String(startIndex)}..${String(endIndex)} for ${String(kernel.tokens.length)} tokens`,
      errorRangeAtIndex(kernel.sql, kernel.tokens, startIndex),
    );
  }
  return {
    kernel,
    index: startIndex,
    endIndex,
    workUnits: kernel.delimiters.scanSteps,
  };
};

const sqlTokenCursorRange = (
  cursor: SqlTokenCursor,
): SqlSourceRange => {
  const current = cursor.index < cursor.endIndex
    ? cursor.kernel.tokens[cursor.index]
    : undefined;
  return current?.range
    ?? emptySqlSourceRange(
      cursor.kernel.tokens[cursor.endIndex - 1]?.range.end
      ?? cursor.kernel.sql.length,
    );
};

export const sqlTokenAt = (
  cursor: SqlTokenCursor,
  offset: number,
): SqlParserToken | undefined => {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `SQL token offset must be a non-negative safe integer; received ${String(offset)} for cursor ${String(cursor.index)}..${String(cursor.endIndex)}`,
      sqlTokenCursorRange(cursor),
    );
  }
  const index = cursor.index + offset;
  if (!Number.isSafeInteger(index)) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `SQL token index overflow for cursor ${String(cursor.index)} with offset ${String(offset)}`,
      sqlTokenCursorRange(cursor),
    );
  }
  return index >= cursor.endIndex ? undefined : cursor.kernel.tokens[index];
};

export const sqlCursorRange = (cursor: SqlTokenCursor): SqlSourceRange =>
  sqlTokenCursorRange(cursor);

export const advanceSqlTokenCursor = (
  cursor: SqlTokenCursor,
  count: number,
  operation: string,
): SqlTokenCursor => {
  if (
    !Number.isSafeInteger(count)
    || count < 0
    || cursor.index + count > cursor.endIndex
  ) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Cannot advance SQL token cursor by ${String(count)} during ${operation} from ${String(cursor.index)} with end ${String(cursor.endIndex)}`,
      sqlCursorRange(cursor),
    );
  }
  const remainingWorkUnits =
    cursor.kernel.limits.maxWorkUnits - cursor.workUnits;
  if (remainingWorkUnits < 0) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `SQL token cursor already exceeds maxWorkUnits=${String(cursor.kernel.limits.maxWorkUnits)} before ${operation}`,
      sqlCursorRange(cursor),
    );
  }
  if (count > remainingWorkUnits) {
    const firstExcessIndex = cursor.index + remainingWorkUnits;
    return throwSqlPolicyParserError(
      "limit_complexity",
      `SQL parser ${operation} exceeded maxWorkUnits=${String(cursor.kernel.limits.maxWorkUnits)} at token ${String(firstExcessIndex)}`,
      errorRangeAtIndex(
        cursor.kernel.sql,
        cursor.kernel.tokens,
        firstExcessIndex,
      ),
    );
  }
  return {
    ...cursor,
    index: cursor.index + count,
    workUnits: cursor.workUnits + count,
  };
};

export const matchingSqlDelimiterIndexAtCursor = (
  cursor: SqlTokenCursor,
): number => {
  const token = sqlTokenAt(cursor, 0);
  const match = cursor.kernel.delimiters.matchingIndexes.get(cursor.index);
  if (
    token === undefined
    || (token.text !== "(" && token.text !== "[")
    || match === undefined
  ) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Token ${String(cursor.index)} is not an indexed opening SQL delimiter`,
      sqlCursorRange(cursor),
    );
  }
  return match;
};

export const matchingSqlDelimiterIndexWithinCursor = (
  cursor: SqlTokenCursor,
  boundaryErrorCode: SqlPolicyParserErrorCode,
  subject: string,
): number => {
  const match = matchingSqlDelimiterIndexAtCursor(cursor);
  if (match >= cursor.endIndex) {
    return throwSqlPolicyParserError(
      boundaryErrorCode,
      `${subject} closes outside the current parse range`,
      sqlCursorRange(cursor),
    );
  }
  return match;
};

export const sqlRangeFromTokenIndexes = (
  kernel: SqlParserKernel,
  startIndex: number,
  endIndex: number,
): SqlSourceRange => {
  const first = kernel.tokens[startIndex];
  const last = kernel.tokens[endIndex - 1];
  if (first === undefined || last === undefined || startIndex >= endIndex) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Cannot create SQL source range from empty token span ${String(startIndex)}..${String(endIndex)}`,
      errorRangeAtIndex(kernel.sql, kernel.tokens, startIndex),
    );
  }
  return { start: first.range.start, end: last.range.end };
};
