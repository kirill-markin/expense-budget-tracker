import assert from "node:assert/strict";
import test from "node:test";
import type {
  SqlIdentifierToken,
  SqlSourceRange,
} from "./sql-policy-lexer.js";
import { postgreSqlTokenWord } from "./sql-policy-parser-keywords.js";
import {
  createSqlParserKernel,
  DEFAULT_SQL_PARSER_LIMITS,
  type SqlParserKernel,
  type SqlParserLimits,
  type SqlParserToken,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  throwSqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";
import type {
  SqlExpressionEnvironment,
  SqlExpressionPrefixReader,
  SqlExpressionResult,
} from "./sql-policy-read-expression.js";
import type {
  SqlCallNode,
  SqlExpressionMetadata,
  SqlNestedQueryNode,
  SqlTypeConstructNode,
} from "./sql-policy-read-model.js";
import {
  concatSqlExpressionMetadataSequences,
  emptySqlExpressionMetadataSequence,
  materializeSqlExpressionMetadataSequence,
  sqlCallMetadataSequence,
  sqlNestedQueryMetadataSequence,
  sqlTypeConstructMetadataSequence,
  type SqlExpressionMetadataSequence,
} from "./sql-policy-read-metadata.js";
import { readSqlWindowFrame } from "./sql-policy-read-frame.js";
import {
  advanceSqlReadCursor,
  consumeSqlReadToken,
  createSqlReadCursor,
  createSqlReadState,
  enterSqlReadDepth,
  inspectSqlReadToken,
  matchingSqlReadDelimiter,
  narrowSqlReadCursor,
  resumeSqlReadCursor,
  sqlReadRangeForSpan,
  type SqlReadCursor,
} from "./sql-policy-read-state.js";
import type { SqlTypeNameNode } from "./sql-policy-type-model.js";

type PrefixReaderInvocation = Readonly<{
  depth: number;
  endIndex: number;
  resultIndex: number;
  startIndex: number;
  workUnits: number;
}>;

type PrefixReaderSnapshot = Readonly<{
  calls: number;
  invocations: ReadonlyArray<PrefixReaderInvocation>;
  lastReturnedWorkUnits: number | null;
  transitions: number;
}>;

type PrefixReaderHarness = Readonly<{
  reader: SqlExpressionPrefixReader;
  snapshot: () => PrefixReaderSnapshot;
}>;

type CursorContractCase = Readonly<{
  message: string;
  mutate: (
    cursor: SqlReadCursor,
    foreign: SqlReadCursor,
  ) => SqlReadCursor;
}>;

const cursorContractCases = (
  operation: string,
  enteredEndIndex: number,
  enteredDepth: number,
): ReadonlyArray<CursorContractCase> => Object.freeze([
  Object.freeze({
    message: `${operation} returned cursor end ${String(enteredEndIndex - 1)} must equal the entered child end ${String(enteredEndIndex)}`,
    mutate: (cursor: SqlReadCursor): SqlReadCursor => Object.freeze({
      ...cursor,
      endIndex: cursor.endIndex - 1,
    }),
  }),
  Object.freeze({
    message: `${operation} returned cursor end ${String(enteredEndIndex + 1)} must equal the entered child end ${String(enteredEndIndex)}`,
    mutate: (cursor: SqlReadCursor): SqlReadCursor => Object.freeze({
      ...cursor,
      endIndex: cursor.endIndex + 1,
    }),
  }),
  Object.freeze({
    message: `${operation} returned cursor nesting depth ${String(enteredDepth - 1)} must equal the entered child depth ${String(enteredDepth)}`,
    mutate: (cursor: SqlReadCursor): SqlReadCursor => Object.freeze({
      ...cursor,
      depth: cursor.depth - 1,
    }),
  }),
  Object.freeze({
    message: `${operation} returned cursor nesting depth ${String(enteredDepth + 1)} must equal the entered child depth ${String(enteredDepth)}`,
    mutate: (cursor: SqlReadCursor): SqlReadCursor => Object.freeze({
      ...cursor,
      depth: cursor.depth + 1,
    }),
  }),
  Object.freeze({
    message: `${operation} returned cursor must use the entered child SQL read state`,
    mutate: (
      cursor: SqlReadCursor,
      foreign: SqlReadCursor,
    ): SqlReadCursor => Object.freeze({
      ...cursor,
      state: foreign.state,
    }),
  }),
  Object.freeze({
    message: `${operation} returned cursor workUnits must be a non-negative safe integer; received -1`,
    mutate: (cursor: SqlReadCursor): SqlReadCursor => Object.freeze({
      ...cursor,
      workUnits: -1,
    }),
  }),
]);

type DeterministicDelimiterRead = Readonly<{
  cursor: SqlReadCursor;
  itemCount: number;
}>;

const limits = (
  maxSourceCodeUnits: number,
  maxTokens: number,
  maxNestingDepth: number,
  maxWorkUnits: number,
): SqlParserLimits => ({
  maxNestingDepth,
  maxSourceCodeUnits,
  maxTokens,
  maxWorkUnits,
});

const environment = (queryId: number): SqlExpressionEnvironment => ({
  context: "root",
  queryId,
  syntaxContext: "expression",
});

const emptyMetadata = (): SqlExpressionMetadataSequence =>
  emptySqlExpressionMetadataSequence();

const expressionMetadata = (
  expressionEnvironment: SqlExpressionEnvironment,
  token: SqlIdentifierToken | undefined,
  range: SqlSourceRange,
  startIndex: number,
  endIndex: number,
): SqlExpressionMetadataSequence => {
  if (token === undefined) {
    return emptyMetadata();
  }
  const call: SqlCallNode = Object.freeze({
    argumentsRange: range,
    context: expressionEnvironment.context,
    path: Object.freeze([token]),
    queryId: expressionEnvironment.queryId,
    range,
    syntaxContext: expressionEnvironment.syntaxContext,
  });
  const nestedQuery: SqlNestedQueryNode = Object.freeze({
    bodyRange: range,
    context: "nested",
    endIndex,
    kind: "expression",
    parentQueryId: expressionEnvironment.queryId,
    range,
    startIndex,
  });
  const typeName: SqlTypeNameNode = Object.freeze({
    arrayBounds: Object.freeze([]),
    form: "generic",
    intervalQualifier: null,
    modifiers: Object.freeze([]),
    nameParts: Object.freeze([token]),
    nameRange: token.range,
    range,
    setOf: false,
    sql: token.text,
    timeZone: null,
  });
  const typeConstruct: SqlTypeConstructNode = Object.freeze({
    context: expressionEnvironment.context,
    queryId: expressionEnvironment.queryId,
    range,
    syntax: "cast",
    typeName,
  });
  return concatSqlExpressionMetadataSequences(
    concatSqlExpressionMetadataSequences(
      sqlCallMetadataSequence(call),
      sqlNestedQueryMetadataSequence(nestedQuery),
    ),
    sqlTypeConstructMetadataSequence(typeConstruct),
  );
};

const isOpeningDelimiter = (token: SqlParserToken): boolean =>
  token.text === "(" || token.text === "[";

const isUnaryOperator = (token: SqlParserToken): boolean =>
  token.kind === "operator"
  && (token.text === "+" || token.text === "-" || token.text === "~");

const isBooleanOperatorWord = (word: string | null): boolean =>
  word === "and" || word === "or";

const isExpressionAtom = (token: SqlParserToken): boolean =>
  (
    token.kind === "identifier"
    && !isBooleanOperatorWord(postgreSqlTokenWord(token))
  )
  || token.kind === "numeric"
  || token.kind === "parameter"
  || token.kind === "string";

const deterministicExpressionError = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "unexpected_token",
  message,
  sqlReadRangeForSpan(
    cursor.state,
    cursor.index,
    cursor.index === cursor.endIndex ? cursor.index : cursor.index + 1,
  ),
);

const skipDeterministicNestedExpression = (
  cursor: SqlReadCursor,
): DeterministicDelimiterRead => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter deterministic prefix-expression delimiter",
  );
  const matched = matchingSqlReadDelimiter(
    nested,
    "Match deterministic prefix-expression delimiter",
  );
  const afterOpen = advanceSqlReadCursor(
    matched.cursor,
    1,
    "Consume deterministic prefix-expression opening delimiter",
  );
  let current = narrowSqlReadCursor(
    afterOpen,
    matched.closeIndex,
    "Bound deterministic prefix-expression delimiter contents",
  );
  let itemCount = 0;
  let next = inspectSqlReadToken(
    current,
    0,
    "Inspect deterministic delimiter item",
  );
  current = next.cursor;
  while (next.token !== undefined) {
    current = readDeterministicNestedExpression(current);
    itemCount++;
    const separator = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic delimiter separator",
    );
    current = separator.cursor;
    if (separator.token === undefined) {
      break;
    }
    if (separator.token.text !== ",") {
      return deterministicExpressionError(
        current,
        "Deterministic nested expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic delimiter comma",
    ).cursor;
    next = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic delimiter item after comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return deterministicExpressionError(
        current,
        "Deterministic delimiter requires an expression after comma",
      );
    }
  }

  const atClose = resumeSqlReadCursor(
    matched.cursor,
    current,
    "Resume deterministic prefix-expression delimiter contents",
  );
  const afterClose = consumeSqlReadToken(
    atClose,
    "Consume deterministic prefix-expression closing delimiter",
  ).cursor;
  return Object.freeze({
    cursor: resumeSqlReadCursor(
      cursor,
      afterClose,
      "Resume deterministic prefix-expression delimiter",
    ),
    itemCount,
  });
};

const requireNonEmptyDeterministicDelimiter = (
  result: DeterministicDelimiterRead,
): SqlReadCursor => {
  if (result.itemCount === 0) {
    return deterministicExpressionError(
      result.cursor,
      "Deterministic grouped expression cannot be empty",
    );
  }
  return result.cursor;
};

const readDeterministicNestedExpression = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = readDeterministicPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic nested expression continuation",
    );
    current = inspected.cursor;
    const token = inspected.token;
    if (token === undefined || token.text === ",") {
      return current;
    }
    const word = postgreSqlTokenWord(token);
    if (!isBooleanOperatorWord(word) && token.kind !== "operator") {
      return deterministicExpressionError(
        current,
        "Deterministic nested expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic nested expression operator",
    ).cursor;
    current = readDeterministicPrimary(current);
  }
};

const readDeterministicCasePrimary = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = consumeSqlReadToken(
    cursor,
    "Consume deterministic CASE",
  ).cursor;
  let depth = 1;
  let expectsOperand = true;
  let hasOuterThen = false;
  let hasOuterWhen = false;

  while (depth > 0) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic CASE expression",
    );
    current = inspected.cursor;
    const token = inspected.token;
    if (token === undefined) {
      return deterministicExpressionError(
        current,
        "Deterministic prefix expression has an incomplete CASE",
      );
    }
    if (isOpeningDelimiter(token)) {
      current = requireNonEmptyDeterministicDelimiter(
        skipDeterministicNestedExpression(current),
      );
      expectsOperand = false;
      continue;
    }

    const word = postgreSqlTokenWord(token);
    if (word === "case") {
      current = consumeSqlReadToken(
        current,
        "Consume deterministic nested CASE",
      ).cursor;
      depth++;
      expectsOperand = true;
      continue;
    }
    if (word === "end") {
      if (expectsOperand) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix CASE requires an expression before END",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE END",
      ).cursor;
      depth--;
      continue;
    }
    if (depth === 1 && word === "when") {
      if (hasOuterWhen && expectsOperand) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix CASE requires a result before WHEN",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE WHEN",
      ).cursor;
      hasOuterWhen = true;
      expectsOperand = true;
      continue;
    }
    if (depth === 1 && word === "then") {
      if (!hasOuterWhen || expectsOperand) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix CASE requires a condition before THEN",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE THEN",
      ).cursor;
      hasOuterThen = true;
      expectsOperand = true;
      continue;
    }
    if (depth === 1 && word === "else") {
      if (!hasOuterThen || expectsOperand) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix CASE requires a result before ELSE",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE ELSE",
      ).cursor;
      expectsOperand = true;
      continue;
    }
    if (isBooleanOperatorWord(word)) {
      if (expectsOperand) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix expression has a trailing operator",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE operator",
      ).cursor;
      expectsOperand = true;
      continue;
    }
    if (token.kind === "operator") {
      if (expectsOperand && !isUnaryOperator(token)) {
        return deterministicExpressionError(
          current,
          "Deterministic prefix expression has a trailing operator",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume deterministic CASE operator",
      ).cursor;
      expectsOperand = true;
      continue;
    }
    if (!isExpressionAtom(token)) {
      return deterministicExpressionError(
        current,
        "Deterministic prefix CASE contains an invalid token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic CASE atom",
    ).cursor;
    expectsOperand = false;
  }

  if (!hasOuterWhen || !hasOuterThen) {
    return deterministicExpressionError(
      current,
      "Deterministic prefix CASE requires WHEN and THEN",
    );
  }
  return current;
};

const readDeterministicPostfix = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic expression postfix",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || !isOpeningDelimiter(inspected.token)) {
      return current;
    }
    current = skipDeterministicNestedExpression(current).cursor;
  }
};

const readDeterministicPrimary = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic expression primary",
    );
    current = inspected.cursor;
    const token = inspected.token;
    if (token === undefined) {
      return deterministicExpressionError(
        current,
        "Deterministic prefix expression requires an operand",
      );
    }
    if (!isUnaryOperator(token)) {
      break;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic expression unary operator",
    ).cursor;
  }

  const atom = current.state.kernel.tokens[current.index];
  if (atom === undefined) {
    return deterministicExpressionError(
      current,
      "Deterministic prefix expression requires an operand",
    );
  }
  if (isOpeningDelimiter(atom)) {
    return readDeterministicPostfix(
      requireNonEmptyDeterministicDelimiter(
        skipDeterministicNestedExpression(current),
      ),
    );
  }
  if (postgreSqlTokenWord(atom) === "case") {
    return readDeterministicPostfix(readDeterministicCasePrimary(current));
  }
  if (!isExpressionAtom(atom)) {
    return deterministicExpressionError(
      current,
      "Deterministic prefix expression requires an operand",
    );
  }
  return readDeterministicPostfix(consumeSqlReadToken(
    current,
    "Consume deterministic expression atom",
  ).cursor);
};

const firstIdentifierToken = (
  cursor: SqlReadCursor,
  endIndex: number,
): SqlIdentifierToken | undefined => {
  const token = cursor.state.kernel.tokens[cursor.index];
  return cursor.index < endIndex && token?.kind === "identifier"
    ? token
    : undefined;
};

const readDeterministicExpressionPrefix = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const startIndex = cursor.index;
  let current = readDeterministicPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic expression continuation",
    );
    current = inspected.cursor;
    const token = inspected.token;
    if (token === undefined) {
      break;
    }
    const word = postgreSqlTokenWord(token);
    if (word === "preceding" || word === "following") {
      break;
    }
    if (!isBooleanOperatorWord(word) && token.kind !== "operator") {
      break;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic expression operator",
    ).cursor;
    current = readDeterministicPrimary(current);
  }

  const range = sqlReadRangeForSpan(
    cursor.state,
    startIndex,
    current.index,
  );
  return Object.freeze({
    cursor: current,
    metadata: expressionMetadata(
      expressionEnvironment,
      firstIdentifierToken(cursor, current.index),
      range,
      startIndex,
      current.index,
    ),
    range,
  });
};

const createPrefixReaderHarness = (): PrefixReaderHarness => {
  let calls = 0;
  let lastReturnedWorkUnits: number | null = null;
  let transitions = 0;
  const invocations: Array<PrefixReaderInvocation> = [];
  const reader: SqlExpressionPrefixReader = (
    expressionEnvironment: SqlExpressionEnvironment,
    cursor: SqlReadCursor,
  ): SqlExpressionResult => {
    calls++;
    const result = readDeterministicExpressionPrefix(
      expressionEnvironment,
      cursor,
    );
    const invocation = Object.freeze({
      depth: cursor.depth,
      endIndex: cursor.endIndex,
      resultIndex: result.cursor.index,
      startIndex: cursor.index,
      workUnits: result.cursor.workUnits - cursor.workUnits,
    });
    invocations.push(invocation);
    lastReturnedWorkUnits = result.cursor.workUnits;
    transitions += invocation.workUnits;
    return result;
  };
  const snapshot = (): PrefixReaderSnapshot => Object.freeze({
    calls,
    invocations: Object.freeze([...invocations]),
    lastReturnedWorkUnits,
    transitions,
  });
  return Object.freeze({ reader, snapshot });
};

const createReadCursor = (
  sql: string,
  parserLimits: SqlParserLimits,
): Readonly<{ cursor: SqlReadCursor; kernel: SqlParserKernel }> => {
  const kernel = createSqlParserKernel(sql, parserLimits);
  const state = createSqlReadState(kernel);
  return Object.freeze({
    cursor: createSqlReadCursor(state, 0, state.tokenCount),
    kernel,
  });
};

const readFrame = (
  sql: string,
  queryId: number,
): Readonly<{
  harness: PrefixReaderHarness;
  kernel: SqlParserKernel;
  result: SqlExpressionResult;
}> => {
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowFrame(
    environment(queryId),
    cursor,
    harness.reader,
  );
  return Object.freeze({ harness, kernel, result });
};

const sourceRange = (
  sql: string,
  text: string,
  occurrence: number,
): SqlSourceRange => {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    start = sql.indexOf(text, from);
    assert.notEqual(start, -1, `Missing ${text} occurrence ${String(occurrence)}`);
    from = start + text.length;
  }
  return { start, end: start + text.length };
};

const expressionSql = (
  sql: string,
  result: SqlExpressionResult,
): ReadonlyArray<string> => materializedMetadata(result).calls.map((call) =>
  sql.slice(call.range.start, call.range.end)
);

const materializedMetadata = (
  result: SqlExpressionResult,
): SqlExpressionMetadata => materializeSqlExpressionMetadataSequence(
  result.metadata,
);

const countMetadataConcatNodes = (
  sequence: SqlExpressionMetadataSequence,
): number => {
  const stack: Array<SqlExpressionMetadataSequence> = [sequence];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    assert.notEqual(current, undefined);
    if (current?.kind === "concat") {
      count++;
      stack.push(current.right, current.left);
    }
  }
  return count;
};

const repeatMetadataSequence = (
  sequence: SqlExpressionMetadataSequence,
  count: number,
): SqlExpressionMetadataSequence => {
  let repeated = emptySqlExpressionMetadataSequence();
  for (let index = 0; index < count; index++) {
    repeated = concatSqlExpressionMetadataSequences(repeated, sequence);
  }
  return repeated;
};

const expectParserError = (
  action: () => unknown,
  code: SqlPolicyParserErrorCode,
  range: SqlSourceRange,
  message: string,
): void => assert.throws(action, (error: unknown): boolean => {
  assert.ok(error instanceof SqlPolicyParserError);
  assert.equal(error.code, code);
  assert.deepEqual(error.range, range);
  assert.equal(error.message, message);
  return true;
});

test("frame reader accepts every mode, ranked bound category, and exclusion", (): void => {
  const cases: ReadonlyArray<Readonly<{
    calls: number;
    sql: string;
  }>> = [
    { calls: 0, sql: "RANGE UNBOUNDED PRECEDING" },
    { calls: 0, sql: "ROWS CURRENT ROW" },
    { calls: 1, sql: "GROUPS 2 PRECEDING" },
    {
      calls: 1,
      sql: "ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING",
    },
    { calls: 1, sql: "RANGE BETWEEN 1 PRECEDING AND CURRENT ROW" },
    { calls: 1, sql: "GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING" },
    {
      calls: 1,
      sql: "ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING",
    },
    { calls: 1, sql: "ROWS 1 PRECEDING EXCLUDE CURRENT ROW" },
    { calls: 1, sql: "ROWS 1 PRECEDING EXCLUDE GROUP" },
    { calls: 1, sql: "ROWS 1 PRECEDING EXCLUDE TIES" },
    { calls: 1, sql: "ROWS 1 PRECEDING EXCLUDE NO OTHERS" },
  ];

  for (const expected of cases) {
    const { harness, kernel, result } = readFrame(expected.sql, 51);
    assert.equal(result.cursor.index, result.cursor.endIndex, expected.sql);
    assert.equal(result.cursor.endIndex, kernel.tokens.length, expected.sql);
    assert.equal(result.cursor.depth, 0, expected.sql);
    assert.deepEqual(result.range, { start: 0, end: expected.sql.length });
    assert.equal(harness.snapshot().calls, expected.calls, expected.sql);
  }
});

test("contextual frame words and boolean AND remain inside offset expressions", (): void => {
  const sql = [
    "ROWS BETWEEN",
    "preceding AND following AND range AND rows AND groups PRECEDING",
    "AND",
    "CASE WHEN preceding AND following THEN range ELSE rows END FOLLOWING",
  ].join(" ");
  const { harness, result } = readFrame(sql, 52);

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(harness.snapshot().calls, 2);
  assert.deepEqual(expressionSql(sql, result), [
    "preceding AND following AND range AND rows AND groups",
    "CASE WHEN preceding AND following THEN range ELSE rows END",
  ]);
  const firstTerminator = result.cursor.state.kernel.tokens[
    harness.snapshot().invocations[0]?.resultIndex ?? -1
  ];
  assert.equal(postgreSqlTokenWord(firstTerminator), "preceding");
});

test("special bound words remain contextual unless the full production exists", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expression: string;
    sql: string;
  }>> = [
    {
      expression: "preceding + rows + 1",
      sql: "ROWS preceding + rows + 1 PRECEDING",
    },
    {
      expression: "unbounded + current + 1",
      sql: "RANGE unbounded + current + 1 PRECEDING",
    },
    {
      expression: "current + following + groups",
      sql: "GROUPS current + following + groups PRECEDING",
    },
  ];

  for (const expected of cases) {
    const { harness, result } = readFrame(expected.sql, 53);
    assert.equal(harness.snapshot().calls, 1, expected.sql);
    assert.deepEqual(expressionSql(expected.sql, result), [expected.expression]);
  }
});

test("nested delimiters shield directions and section words", (): void => {
  const sql = [
    "ROWS outer(preceding AND following, range, rows)[groups]",
    "+ (preceding AND following + range + rows + groups) PRECEDING",
  ].join(" ");
  const { harness, result } = readFrame(sql, 54);

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(result.cursor.depth, 0);
  assert.equal(harness.snapshot().calls, 1);
  assert.deepEqual(expressionSql(sql, result), [
    "outer(preceding AND following, range, rows)[groups] + (preceding AND following + range + rows + groups)",
  ]);
});

test("frame reader reports exact mode, bound, direction, separator, and trailing errors", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      message: "Window frame requires RANGE, ROWS, or GROUPS",
      range: { start: 0, end: 0 },
      sql: "",
    },
    {
      message: "Window frame requires RANGE, ROWS, or GROUPS",
      range: { start: 0, end: 5 },
      sql: "VALUE 1 PRECEDING",
    },
    {
      message: "Window frame requires a bound",
      range: { start: 4, end: 4 },
      sql: "ROWS",
    },
    {
      message: "Window frame offset requires PRECEDING or FOLLOWING",
      range: { start: 17, end: 17 },
      sql: "ROWS offset_value",
    },
    {
      message: "Window frame offset requires PRECEDING or FOLLOWING",
      range: { start: 18, end: 26 },
      sql: "ROWS offset_value sideways",
    },
    {
      message: "Window frame BETWEEN requires AND",
      range: { start: 25, end: 26 },
      sql: "ROWS BETWEEN 1 PRECEDING 2 FOLLOWING",
    },
    {
      message: "Window frame requires a bound",
      range: { start: 28, end: 28 },
      sql: "ROWS BETWEEN 1 PRECEDING AND",
    },
    {
      message: "Unexpected token after the window frame clause",
      range: { start: 17, end: 21 },
      sql: "ROWS 1 PRECEDING junk",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlWindowFrame(
        environment(55),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("frame reader reports exact EXCLUDE errors", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      message: "Window frame EXCLUDE requires CURRENT ROW, GROUP, TIES, or NO OTHERS",
      range: { start: 24, end: 24 },
      sql: "ROWS 1 PRECEDING EXCLUDE",
    },
    {
      message: "Window frame EXCLUDE CURRENT requires ROW",
      range: { start: 32, end: 32 },
      sql: "ROWS 1 PRECEDING EXCLUDE CURRENT",
    },
    {
      message: "Window frame EXCLUDE NO requires OTHERS",
      range: { start: 27, end: 27 },
      sql: "ROWS 1 PRECEDING EXCLUDE NO",
    },
    {
      message: "Window frame EXCLUDE requires CURRENT ROW, GROUP, TIES, or NO OTHERS",
      range: { start: 25, end: 32 },
      sql: "ROWS 1 PRECEDING EXCLUDE INVALID",
    },
    {
      message: "Window frame cannot contain more than one EXCLUDE clause",
      range: { start: 30, end: 37 },
      sql: "ROWS 1 PRECEDING EXCLUDE TIES EXCLUDE GROUP",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlWindowFrame(
        environment(56),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("ranked bounds enforce PostgreSQL endpoint restrictions", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    rangeText: string;
    rangeOccurrence: number;
    sql: string;
  }>> = [
    {
      message: "Window frame start cannot be UNBOUNDED FOLLOWING",
      rangeOccurrence: 0,
      rangeText: "UNBOUNDED FOLLOWING",
      sql: "ROWS UNBOUNDED FOLLOWING",
    },
    {
      message: "Window frame start offset FOLLOWING cannot be later than the implicit CURRENT ROW end",
      rangeOccurrence: 0,
      rangeText: "1 FOLLOWING",
      sql: "ROWS 1 FOLLOWING",
    },
    {
      message: "Window frame start cannot be UNBOUNDED FOLLOWING",
      rangeOccurrence: 0,
      rangeText: "UNBOUNDED FOLLOWING",
      sql: "ROWS BETWEEN UNBOUNDED FOLLOWING AND UNBOUNDED FOLLOWING",
    },
    {
      message: "Window frame end cannot be UNBOUNDED PRECEDING",
      rangeOccurrence: 1,
      rangeText: "UNBOUNDED PRECEDING",
      sql: "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED PRECEDING",
    },
    {
      message: "Window frame end CURRENT ROW cannot precede frame start offset FOLLOWING",
      rangeOccurrence: 0,
      rangeText: "CURRENT ROW",
      sql: "ROWS BETWEEN 1 FOLLOWING AND CURRENT ROW",
    },
    {
      message: "Window frame end offset PRECEDING cannot precede frame start CURRENT ROW",
      rangeOccurrence: 0,
      rangeText: "1 PRECEDING",
      sql: "ROWS BETWEEN CURRENT ROW AND 1 PRECEDING",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlWindowFrame(
        environment(57),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      sourceRange(invalid.sql, invalid.rangeText, invalid.rangeOccurrence),
      invalid.message,
    );
  }
});

test("offset metadata stays ordered, exact, and frozen", (): void => {
  const sql = "ROWS BETWEEN alpha + 1 PRECEDING AND beta + 2 FOLLOWING";
  const { harness, result } = readFrame(sql, 58);
  const metadata = materializedMetadata(result);

  assert.equal(harness.snapshot().calls, 2);
  assert.deepEqual(expressionSql(sql, result), ["alpha + 1", "beta + 2"]);
  assert.deepEqual(
    metadata.nestedQueries.map((query) =>
      sql.slice(query.range.start, query.range.end)
    ),
    ["alpha + 1", "beta + 2"],
  );
  assert.deepEqual(
    metadata.typeConstructs.map((construct) =>
      sql.slice(construct.range.start, construct.range.end)
    ),
    ["alpha + 1", "beta + 2"],
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metadata), true);
  assert.equal(Object.isFrozen(metadata.calls), true);
  assert.equal(Object.isFrozen(metadata.nestedQueries), true);
  assert.equal(Object.isFrozen(metadata.typeConstructs), true);
  assert.equal(countMetadataConcatNodes(result.metadata), 5);
});

test("frame reader preserves canonical empty and deep child sequences", (): void => {
  const empty = readFrame("ROWS CURRENT ROW", 64).result;
  assert.equal(empty.metadata, emptySqlExpressionMetadataSequence());

  const deepCount = 20_000;
  const sql = "ROWS offset_value PRECEDING";
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const token = kernel.tokens[1];
  assert.equal(token?.kind, "identifier");
  assert.ok(token?.kind === "identifier");
  const range = sourceRange(sql, "offset_value", 0);
  const deepMetadata = repeatMetadataSequence(
    expressionMetadata(environment(64), token, range, 1, 2),
    deepCount,
  );
  const reader: SqlExpressionPrefixReader = (
    expressionEnvironment: SqlExpressionEnvironment,
    child: SqlReadCursor,
  ): SqlExpressionResult => Object.freeze({
    ...readDeterministicExpressionPrefix(expressionEnvironment, child),
    metadata: deepMetadata,
  });
  const baseline = readSqlWindowFrame(
    environment(64),
    cursor,
    readDeterministicExpressionPrefix,
  );
  const result = readSqlWindowFrame(environment(64), cursor, reader);
  const metadata = materializedMetadata(result);

  assert.equal(result.metadata, deepMetadata);
  assert.equal(metadata.calls.length, deepCount);
  assert.equal(metadata.nestedQueries.length, deepCount);
  assert.equal(metadata.typeConstructs.length, deepCount);
  assert.equal(result.cursor.workUnits, baseline.cursor.workUnits);
});

test("bounded parents and exact prefix cursors resume their bound and depth", (): void => {
  const sql = "prefix ROWS offset_value PRECEDING EXCLUDE TIES trailing";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const state = createSqlReadState(kernel);
  const parent = enterSqlReadDepth(
    enterSqlReadDepth(
      createSqlReadCursor(state, 1, kernel.tokens.length - 1),
      "Enter bounded frame parent",
    ),
    "Enter deeper bounded frame parent",
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowFrame(
    environment(59),
    parent,
    harness.reader,
  );
  const invocation = harness.snapshot().invocations[0];

  assert.equal(result.cursor.state, parent.state);
  assert.equal(result.cursor.index, parent.endIndex);
  assert.equal(result.cursor.endIndex, parent.endIndex);
  assert.equal(result.cursor.depth, parent.depth);
  assert.equal(invocation?.startIndex, 2);
  assert.equal(invocation?.endIndex, parent.endIndex);
  assert.equal(invocation?.depth, parent.depth + 1);
  assert.equal(
    sql.slice(result.range.start, result.range.end),
    "ROWS offset_value PRECEDING EXCLUDE TIES",
  );
  assert.equal(kernel.tokens[result.cursor.index]?.text, "trailing");
});

test("empty prefix results fail as cursor-contract invariants", (): void => {
  const sql = "ROWS value PRECEDING";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const emptyReader: SqlExpressionPrefixReader = (
    _expressionEnvironment: SqlExpressionEnvironment,
    child: SqlReadCursor,
  ): SqlExpressionResult => Object.freeze({
    cursor: child,
    metadata: emptyMetadata(),
    range: sqlReadRangeForSpan(child.state, child.index, child.index),
  });

  expectParserError(
    () => readSqlWindowFrame(environment(60), cursor, emptyReader),
    "internal_invariant",
    sourceRange(sql, "value", 0),
    "Window frame offset prefix reader returned an empty expression",
  );
});

test("frame offset collaborators must preserve the entered cursor", (): void => {
  const sql = "ROWS value PRECEDING";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const foreign = createReadCursor("other", DEFAULT_SQL_PARSER_LIMITS).cursor;
  const cases = cursorContractCases(
    "Resume window frame offset expression",
    3,
    1,
  );

  for (const current of cases) {
    const reader: SqlExpressionPrefixReader = (
      expressionEnvironment: SqlExpressionEnvironment,
      child: SqlReadCursor,
    ): SqlExpressionResult => {
      const result = readDeterministicExpressionPrefix(
        expressionEnvironment,
        child,
      );
      return Object.freeze({
        ...result,
        cursor: current.mutate(result.cursor, foreign),
      });
    };
    expectParserError(
      () => readSqlWindowFrame(environment(65), cursor, reader),
      "internal_invariant",
      sourceRange(sql, "value", 0),
      current.message,
    );
  }
});

test("frame and collaborator nesting fail at the exact opening token", (): void => {
  const frameSql = "ROWS value PRECEDING";
  const frameKernel = createSqlParserKernel(
    frameSql,
    limits(frameSql.length, 10, 1, 100),
  );
  const frameState = createSqlReadState(frameKernel);
  const frameParent = enterSqlReadDepth(
    createSqlReadCursor(frameState, 0, frameState.tokenCount),
    "Fill frame parent nesting",
  );
  const frameHarness = createPrefixReaderHarness();
  expectParserError(
    () => readSqlWindowFrame(
      environment(61),
      frameParent,
      frameHarness.reader,
    ),
    "limit_nesting",
    sourceRange(frameSql, "value", 0),
    "Enter window frame offset expression nesting depth 2 exceeds maxNestingDepth=1",
  );
  assert.equal(frameHarness.snapshot().calls, 0);

  const nestedSql = "ROWS (value) PRECEDING";
  const nested = createReadCursor(
    nestedSql,
    limits(nestedSql.length, 10, 1, 100),
  );
  const nestedHarness = createPrefixReaderHarness();
  expectParserError(
    () => readSqlWindowFrame(
      environment(61),
      nested.cursor,
      nestedHarness.reader,
    ),
    "limit_nesting",
    sourceRange(nestedSql, "(", 0),
    "Enter deterministic prefix-expression delimiter nesting depth 2 exceeds maxNestingDepth=1",
  );
  assert.equal(nestedHarness.snapshot().calls, 1);
});

test("deterministic prefix collaborator rejects incomplete expressions", (): void => {
  const sql = "ROWS 1 +";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const harness = createPrefixReaderHarness();

  expectParserError(
    () => readSqlWindowFrame(environment(61), cursor, harness.reader),
    "unexpected_token",
    { start: sql.length, end: sql.length },
    "Deterministic prefix expression requires an operand",
  );
  assert.equal(harness.snapshot().calls, 1);
});

test("deterministic prefix collaborator rejects boolean operators in operand position", (): void => {
  const cases: ReadonlyArray<Readonly<{
    occurrence: number;
    operator: "AND" | "OR";
    sql: string;
  }>> = [
    { occurrence: 0, operator: "AND", sql: "ROWS 1 + AND PRECEDING" },
    { occurrence: 0, operator: "OR", sql: "ROWS 1 + OR PRECEDING" },
    { occurrence: 0, operator: "AND", sql: "ROWS AND + 1 PRECEDING" },
    { occurrence: 0, operator: "OR", sql: "ROWS OR + 1 PRECEDING" },
    { occurrence: 0, operator: "OR", sql: "ROWS 1 AND OR 2 PRECEDING" },
    { occurrence: 0, operator: "AND", sql: "ROWS 1 OR AND 2 PRECEDING" },
    { occurrence: 1, operator: "AND", sql: "ROWS 1 AND AND 2 PRECEDING" },
    { occurrence: 1, operator: "OR", sql: "ROWS 1 OR OR 2 PRECEDING" },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlWindowFrame(
        environment(62),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      sourceRange(invalid.sql, invalid.operator, invalid.occurrence),
      "Deterministic prefix expression requires an operand",
    );
    assert.equal(harness.snapshot().calls, 1, invalid.sql);
  }
});

test("deterministic prefix collaborator preserves valid boolean and CASE neighbors", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expression: string;
    sql: string;
  }>> = [
    {
      expression: "1 AND preceding",
      sql: "ROWS 1 AND preceding PRECEDING",
    },
    {
      expression: "1 OR following",
      sql: "ROWS 1 OR following PRECEDING",
    },
    {
      expression: "preceding AND following OR range",
      sql: "ROWS preceding AND following OR range PRECEDING",
    },
    {
      expression: "CASE WHEN preceding AND following OR range THEN rows ELSE groups END",
      sql: "ROWS CASE WHEN preceding AND following OR range THEN rows ELSE groups END PRECEDING",
    },
    {
      expression: "\"AND\" + \"OR\"",
      sql: "ROWS \"AND\" + \"OR\" PRECEDING",
    },
  ];

  for (const valid of cases) {
    const { cursor } = createReadCursor(
      valid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    const result = readSqlWindowFrame(
      environment(63),
      cursor,
      harness.reader,
    );
    const invocation = harness.snapshot().invocations[0];
    assert.notEqual(invocation, undefined, valid.sql);
    assert.ok(invocation !== undefined);
    const range = sqlReadRangeForSpan(
      result.cursor.state,
      invocation.startIndex,
      invocation.resultIndex,
    );
    assert.equal(
      valid.sql.slice(range.start, range.end),
      valid.expression,
      valid.sql,
    );
    assert.equal(result.cursor.index, result.cursor.endIndex, valid.sql);
    assert.equal(harness.snapshot().calls, 1, valid.sql);
  }
});

test("long contextual offsets use exactly one prefix call per bound and linear work", (): void => {
  const contextualWords = ["preceding", "following", "range", "rows", "groups"];
  const identifiers = Array.from(
    { length: 620 },
    (_unused, index) => contextualWords[index % contextualWords.length],
  );
  const firstExpression = identifiers.slice(0, 310).join(" + ");
  const secondExpression = identifiers.slice(310).join(" + ");
  const sql = [
    "ROWS BETWEEN",
    firstExpression,
    "PRECEDING AND",
    secondExpression,
    "FOLLOWING",
  ].join(" ");
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowFrame(
    environment(62),
    cursor,
    harness.reader,
  );
  const snapshot = harness.snapshot();
  const totalTransitions = result.cursor.workUnits - cursor.workUnits;
  const frameTransitions = totalTransitions - snapshot.transitions;

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(kernel.tokens.length, 1_243);
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.invocations.length, 2);
  assert.equal(
    postgreSqlTokenWord(kernel.tokens[snapshot.invocations[0]?.resultIndex ?? -1]),
    "preceding",
  );
  assert.equal(
    postgreSqlTokenWord(kernel.tokens[snapshot.invocations[1]?.resultIndex ?? -1]),
    "following",
  );
  assert.equal(snapshot.transitions, 3_098);
  assert.equal(frameTransitions, 16);
  assert.equal(totalTransitions, 3_114);
  assert.equal(totalTransitions <= kernel.tokens.length * 8, true);
});

test("work limits preserve prefix charges and fail at the exact first excess", (): void => {
  const sql = "ROWS contextual + rows + 1 PRECEDING EXCLUDE TIES";
  const ample = createReadCursor(
    sql,
    limits(sql.length, 30, 4, 1_000),
  );
  const ampleHarness = createPrefixReaderHarness();
  const measured = readSqlWindowFrame(
    environment(63),
    ample.cursor,
    ampleHarness.reader,
  );
  const exactLimit = measured.cursor.workUnits;
  const prefixLimit = ampleHarness.snapshot().lastReturnedWorkUnits;
  const prefixResultIndex = ampleHarness.snapshot().invocations[0]?.resultIndex;
  assert.notEqual(prefixLimit, null);
  assert.notEqual(prefixResultIndex, undefined);

  const exact = createReadCursor(
    sql,
    limits(sql.length, 30, 4, exactLimit),
  );
  const exactHarness = createPrefixReaderHarness();
  const exactResult = readSqlWindowFrame(
    environment(63),
    exact.cursor,
    exactHarness.reader,
  );
  assert.equal(exactResult.cursor.workUnits, exactLimit);

  const firstExcess = createReadCursor(
    sql,
    limits(sql.length, 30, 4, exactLimit - 1),
  );
  const firstExcessHarness = createPrefixReaderHarness();
  expectParserError(
    () => readSqlWindowFrame(
      environment(63),
      firstExcess.cursor,
      firstExcessHarness.reader,
    ),
    "limit_complexity",
    { start: sql.length, end: sql.length },
    `SQL parser Inspect token after window frame clause exceeded maxWorkUnits=${String(exactLimit - 1)} at token ${String(firstExcess.kernel.tokens.length)}`,
  );

  assert.ok(prefixLimit !== null);
  assert.ok(prefixResultIndex !== undefined);
  const prefixBounded = createReadCursor(
    sql,
    limits(sql.length, 30, 4, prefixLimit),
  );
  const prefixBoundedHarness = createPrefixReaderHarness();
  expectParserError(
    () => readSqlWindowFrame(
      environment(63),
      prefixBounded.cursor,
      prefixBoundedHarness.reader,
    ),
    "limit_complexity",
    sourceRange(sql, "PRECEDING", 0),
    `SQL parser Inspect window frame offset direction exceeded maxWorkUnits=${String(prefixLimit)} at token ${String(prefixResultIndex)}`,
  );
  assert.equal(
    prefixBoundedHarness.snapshot().lastReturnedWorkUnits,
    prefixLimit,
  );
});
