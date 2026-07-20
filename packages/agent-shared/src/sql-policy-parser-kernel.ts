import {
  lexSqlPolicyInfrastructure,
  type SqlCommentToken,
  type SqlLexedScript,
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

export const DEFAULT_SQL_PARSER_LIMITS: SqlParserLimits = Object.freeze({
  maxSourceCodeUnits: 1_000_000,
  maxTokens: 100_000,
  maxNestingDepth: 256,
  maxWorkUnits: 500_000,
});

export type SqlParserStatementSpan = Readonly<{
  range: SqlSourceRange;
  terminatorRange: SqlSourceRange | null;
  startIndex: number;
  endIndex: number;
}>;

export type SqlDelimiterLookup = Readonly<{
  get: (index: number) => number | undefined;
  size: number;
}>;

export type SqlDelimiterIndex = Readonly<{
  matchingIndexes: SqlDelimiterLookup;
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

const isNonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const PARSER_LIMIT_FIELDS: ReadonlyArray<string> = Object.freeze([
  "maxSourceCodeUnits",
  "maxTokens",
  "maxNestingDepth",
  "maxWorkUnits",
]);

const hasExactOwnParserLimitFields = (limits: SqlParserLimits): boolean => {
  if (
    typeof limits !== "object"
    || limits === null
    || Array.isArray(limits)
    || Object.getPrototypeOf(limits) !== Object.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(limits);
  if (
    keys.length !== PARSER_LIMIT_FIELDS.length
    || keys.some((key) => typeof key !== "string")
    || PARSER_LIMIT_FIELDS.some((field) => !keys.includes(field))
  ) {
    return false;
  }
  return PARSER_LIMIT_FIELDS.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(limits, field);
    return descriptor !== undefined && "value" in descriptor;
  });
};

const validatePositiveLimit = (
  field: keyof SqlParserLimits,
  value: number,
): void => {
  if (typeof value !== "number") {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser ${field} must be a primitive number; received value type ${typeof value}`,
      emptySqlSourceRange(0),
    );
  }
  if (!isPositiveInteger(value)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser ${field} must be a positive safe integer; received ${String(value)}`,
      emptySqlSourceRange(0),
    );
  }
};

const validateLimits = (limits: SqlParserLimits): void => {
  validatePositiveLimit("maxSourceCodeUnits", limits.maxSourceCodeUnits);
  validatePositiveLimit("maxTokens", limits.maxTokens);
  validatePositiveLimit("maxNestingDepth", limits.maxNestingDepth);
  validatePositiveLimit("maxWorkUnits", limits.maxWorkUnits);
};

const snapshotParserLimits = (limits: SqlParserLimits): SqlParserLimits => {
  if (!hasExactOwnParserLimitFields(limits)) {
    return throwSqlPolicyParserError(
      "invalid_configuration",
      `SQL parser limits must be a plain object with exactly the own data fields ${PARSER_LIMIT_FIELDS.join(", ")}`,
      emptySqlSourceRange(0),
    );
  }
  const owned: SqlParserLimits = {
    maxNestingDepth: limits.maxNestingDepth,
    maxSourceCodeUnits: limits.maxSourceCodeUnits,
    maxTokens: limits.maxTokens,
    maxWorkUnits: limits.maxWorkUnits,
  };
  validateLimits(owned);
  return Object.freeze(owned);
};

const ownSqlSourceRange = (range: SqlSourceRange): SqlSourceRange =>
  Object.freeze({ start: range.start, end: range.end });

const unsupportedSqlPolicyToken = (token: never): never => {
  void token;
  return throwSqlPolicyParserError(
    "internal_invariant",
    "SQL lexer returned an unsupported token discriminant",
    emptySqlSourceRange(0),
  );
};

const ownSqlPolicyToken = (token: SqlPolicyToken): SqlPolicyToken => {
  const range = ownSqlSourceRange(token.range);
  if (token.kind === "whitespace") {
    return Object.freeze({ kind: "whitespace", range, text: token.text });
  }
  if (token.kind === "comment") {
    return Object.freeze({
      kind: "comment",
      range,
      style: token.style,
      text: token.text,
    });
  }
  if (token.kind === "identifier") {
    return Object.freeze({
      kind: "identifier",
      normalized: token.normalized,
      quoted: token.quoted,
      range,
      text: token.text,
      truncated: token.truncated,
      unicodeEscapeCharacter: token.unicodeEscapeCharacter,
      unicodeEscaped: token.unicodeEscaped,
      untruncatedNormalized: token.untruncatedNormalized,
    });
  }
  if (token.kind === "string") {
    const semanticSegments = Object.freeze(
      token.semanticSegments.map((segment) =>
        Object.freeze({
          range: ownSqlSourceRange(segment.range),
          value: segment.value,
        }),
      ),
    );
    return Object.freeze({
      dollarTag: token.dollarTag,
      kind: "string",
      range,
      semanticSegments,
      semanticValue: token.semanticValue,
      style: token.style,
      text: token.text,
      unicodeEscapeCharacter: token.unicodeEscapeCharacter,
    });
  }
  if (token.kind === "parameter") {
    return Object.freeze({
      kind: "parameter",
      position: token.position,
      positionText: token.positionText,
      range,
      text: token.text,
    });
  }
  if (token.kind === "numeric") {
    if (token.valid) {
      return Object.freeze({
        form: token.form,
        kind: "numeric",
        normalized: token.normalized,
        range,
        text: token.text,
        valid: true,
      });
    }
    return Object.freeze({
      diagnostic: Object.freeze({
        code: token.diagnostic.code,
        message: token.diagnostic.message,
      }),
      kind: "numeric",
      range,
      text: token.text,
      valid: false,
    });
  }
  if (token.kind === "operator") {
    return Object.freeze({ kind: "operator", range, text: token.text });
  }
  if (token.kind === "punctuation") {
    return Object.freeze({ kind: "punctuation", range, text: token.text });
  }
  return unsupportedSqlPolicyToken(token);
};

const ownSqlSourceTokens = (
  tokens: ReadonlyArray<SqlPolicyToken>,
): ReadonlyArray<SqlPolicyToken> =>
  Object.freeze(tokens.map(ownSqlPolicyToken));

type SignificantTokenLimitScan = Readonly<{
  count: number;
  firstExcess: SqlPolicyToken | null;
}>;

const scanSignificantTokenLimit = (
  tokens: ReadonlyArray<SqlPolicyToken>,
  maxTokens: number,
): SignificantTokenLimitScan => {
  let count = 0;
  let firstExcess: SqlPolicyToken | null = null;
  for (const token of tokens) {
    if (token.kind === "comment" || token.kind === "whitespace") {
      continue;
    }
    if (count === maxTokens) {
      firstExcess = token;
    }
    count++;
  }
  return { count, firstExcess };
};

const significantTokens = (
  sourceTokens: ReadonlyArray<SqlPolicyToken>,
): ReadonlyArray<SqlParserToken> =>
  Object.freeze(sourceTokens.filter(
    (token): token is SqlParserToken =>
      token.kind !== "comment" && token.kind !== "whitespace",
  ));

const errorRangeAtIndex = (
  sql: string,
  tokens: ReadonlyArray<SqlParserToken>,
  index: number,
): SqlSourceRange =>
  tokens[index]?.range ?? emptySqlSourceRange(sql.length);

const assertNumericTokensValid = (
  tokens: ReadonlyArray<SqlParserToken>,
): void => {
  for (const token of tokens) {
    if (token.kind !== "numeric" || token.valid) {
      continue;
    }
    return throwSqlPolicyParserError(
      "invalid_numeric",
      `Invalid PostgreSQL numeric token at offset ${String(token.range.start)}: ${token.diagnostic.message}`,
      token.range,
    );
  }
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
  const matchingIndexes: Array<number | null> = Array.from(
    { length: tokens.length },
    (): null => null,
  );
  const stack: Array<OpenDelimiter> = [];
  let scanSteps = 0;
  let matchedDelimiterCount = 0;

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
    matchingIndexes[open.index] = index;
    matchingIndexes[index] = open.index;
    matchedDelimiterCount += 2;
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

  const ownedMatches = Object.freeze(matchingIndexes);
  const get = Object.freeze((index: number): number | undefined => {
    if (!isNonNegativeInteger(index) || index >= ownedMatches.length) {
      return undefined;
    }
    return ownedMatches[index] ?? undefined;
  });
  return Object.freeze({
    matchingIndexes: Object.freeze({
      get,
      size: matchedDelimiterCount,
    }),
    scanSteps,
  });
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
  return Object.freeze(tokenSpans.map((span, index) => {
    const statement = lexed.statements[index];
    if (statement === undefined) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        `SQL lexer statement ${String(index)} disappeared during parser indexing`,
        emptySqlSourceRange(sql.length),
      );
    }
    return Object.freeze({
      endIndex: span.endIndex,
      range: ownSqlSourceRange(statement.range),
      startIndex: span.startIndex,
      terminatorRange: statement.terminatorRange === null
        ? null
        : ownSqlSourceRange(statement.terminatorRange),
    });
  }));
};

export const createSqlParserKernel = (
  sql: string,
  limits: SqlParserLimits,
): SqlParserKernel => {
  const ownedLimits = snapshotParserLimits(limits);
  if (sql.length > ownedLimits.maxSourceCodeUnits) {
    return throwSqlPolicyParserError(
      "limit_source_length",
      `SQL source length ${String(sql.length)} UTF-16 code units exceeds maxSourceCodeUnits=${String(ownedLimits.maxSourceCodeUnits)}; the first excess code unit is at offset ${String(ownedLimits.maxSourceCodeUnits)}`,
      {
        start: ownedLimits.maxSourceCodeUnits,
        end: ownedLimits.maxSourceCodeUnits + 1,
      },
    );
  }
  const lexed = lexSqlPolicyInfrastructure(sql);
  const limitScan = scanSignificantTokenLimit(
    lexed.tokens,
    ownedLimits.maxTokens,
  );
  if (limitScan.firstExcess !== null) {
    return throwSqlPolicyParserError(
      "limit_tokens",
      `SQL parser token count ${String(limitScan.count)} exceeds maxTokens=${String(ownedLimits.maxTokens)}`,
      limitScan.firstExcess.range,
    );
  }
  const sourceTokens = ownSqlSourceTokens(lexed.tokens);
  const tokens = significantTokens(sourceTokens);
  assertNumericTokensValid(tokens);
  const delimiters = buildDelimiterIndex(sql, tokens, ownedLimits);
  const statements = buildStatementSpans(sql, tokens, lexed);
  return Object.freeze({
    delimiters,
    limits: ownedLimits,
    sourceTokens,
    sql,
    statements,
    tokens,
  });
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
