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
import { readSqlWindowSpecification } from "./sql-policy-read-window.js";
import type { SqlTypeNameNode } from "./sql-policy-type-model.js";

type PrefixReaderInvocation = Readonly<{
  depth: number;
  endIndex: number;
  resultIndex: number;
  resultWorkUnits: number;
  startIndex: number;
  startWorkUnits: number;
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

const emptyMetadata = (): SqlExpressionMetadata => Object.freeze({
  calls: Object.freeze([]),
  nestedQueries: Object.freeze([]),
  typeConstructs: Object.freeze([]),
});

const callMetadata = (
  expressionEnvironment: SqlExpressionEnvironment,
  token: SqlIdentifierToken,
  range: SqlSourceRange,
  startIndex: number,
  endIndex: number,
  sql: string,
): SqlExpressionMetadata => {
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
    nameParts: call.path,
    nameRange: token.range,
    range,
    setOf: false,
    sql,
    timeZone: null,
  });
  const typeConstruct: SqlTypeConstructNode = Object.freeze({
    context: expressionEnvironment.context,
    queryId: expressionEnvironment.queryId,
    range,
    syntax: "cast",
    typeName,
  });
  return Object.freeze({
    calls: Object.freeze([call]),
    nestedQueries: Object.freeze([nestedQuery]),
    typeConstructs: Object.freeze([typeConstruct]),
  });
};

const deterministicPrefixError = (
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

const isOpeningDelimiter = (token: SqlParserToken): boolean =>
  token.text === "(" || token.text === "[";

const isUnaryOperator = (token: SqlParserToken): boolean =>
  token.kind === "operator"
  && (token.text === "+" || token.text === "-" || token.text === "~");

const isBooleanOperator = (word: string | null): boolean =>
  word === "and" || word === "or";

const isExpressionAtom = (token: SqlParserToken): boolean =>
  (
    token.kind === "identifier"
    && !isBooleanOperator(postgreSqlTokenWord(token))
  )
  || token.kind === "numeric"
  || token.kind === "parameter"
  || token.kind === "string";

const readNestedExpression = (cursor: SqlReadCursor): SqlReadCursor => {
  let current = readPrefixPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic nested window expression continuation",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      return current;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (inspected.token.kind !== "operator" && !isBooleanOperator(word)) {
      return deterministicPrefixError(
        current,
        "Deterministic nested window expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic nested window expression operator",
    ).cursor;
    current = readPrefixPrimary(current);
  }
};

const readPrefixDelimiter = (cursor: SqlReadCursor): SqlReadCursor => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter deterministic window prefix-expression delimiter",
  );
  const matched = matchingSqlReadDelimiter(
    nested,
    "Match deterministic window prefix-expression delimiter",
  );
  const afterOpening = advanceSqlReadCursor(
    matched.cursor,
    1,
    "Consume deterministic window prefix-expression opening delimiter",
  );
  let current = narrowSqlReadCursor(
    afterOpening,
    matched.closeIndex,
    "Bound deterministic window prefix-expression delimiter contents",
  );
  let itemCount = 0;

  while (true) {
    const item = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window delimiter item",
    );
    current = item.cursor;
    if (item.token === undefined) {
      if (itemCount === 0) {
        return deterministicPrefixError(
          current,
          "Deterministic grouped window expression cannot be empty",
        );
      }
      break;
    }

    current = readNestedExpression(current);
    itemCount++;
    const separator = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window delimiter separator",
    );
    current = separator.cursor;
    if (separator.token === undefined) {
      break;
    }
    if (separator.token.text !== ",") {
      return deterministicPrefixError(
        current,
        "Deterministic nested window expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic window delimiter comma",
    ).cursor;
  }

  const atClosing = resumeSqlReadCursor(
    matched.cursor,
    current,
    "Resume deterministic window prefix-expression delimiter contents",
  );
  const afterClosing = consumeSqlReadToken(
    atClosing,
    "Consume deterministic window prefix-expression closing delimiter",
  ).cursor;
  return resumeSqlReadCursor(
    cursor,
    afterClosing,
    "Resume deterministic window prefix-expression delimiter",
  );
};

const readPrefixPostfix = (cursor: SqlReadCursor): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window expression postfix",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return current;
    }
    if (isOpeningDelimiter(inspected.token)) {
      current = readPrefixDelimiter(current);
      continue;
    }
    if (inspected.token.text !== ".") {
      return current;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic window expression field dot",
    ).cursor;
    const field = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window expression field",
    );
    current = field.cursor;
    if (
      field.token?.kind !== "identifier"
      && !(field.token?.kind === "operator" && field.token.text === "*")
    ) {
      return deterministicPrefixError(
        current,
        "Deterministic window expression field selection is incomplete",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic window expression field",
    ).cursor;
  }
};

const readPrefixPrimary = (cursor: SqlReadCursor): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window expression primary",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return deterministicPrefixError(
        current,
        "Deterministic window prefix expression requires an operand",
      );
    }
    if (isUnaryOperator(inspected.token)) {
      current = consumeSqlReadToken(
        current,
        "Consume deterministic window expression unary operator",
      ).cursor;
      continue;
    }
    if (isOpeningDelimiter(inspected.token)) {
      return readPrefixPostfix(readPrefixDelimiter(current));
    }
    if (!isExpressionAtom(inspected.token)) {
      return deterministicPrefixError(
        current,
        "Deterministic window prefix expression requires an operand",
      );
    }
    return readPrefixPostfix(consumeSqlReadToken(
      current,
      "Consume deterministic window expression atom",
    ).cursor);
  }
};

const readDeterministicExpressionPrefix = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const startIndex = cursor.index;
  let current = readPrefixPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic window expression continuation",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      break;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (inspected.token.kind !== "operator" && !isBooleanOperator(word)) {
      break;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic window expression operator",
    ).cursor;
    current = readPrefixPrimary(current);
  }

  const range = sqlReadRangeForSpan(
    cursor.state,
    startIndex,
    current.index,
  );
  const first = cursor.state.kernel.tokens[startIndex];
  return Object.freeze({
    cursor: current,
    metadata: first?.kind === "identifier"
      ? callMetadata(
        expressionEnvironment,
        first,
        range,
        startIndex,
        current.index,
        cursor.state.kernel.sql.slice(range.start, range.end),
      )
      : emptyMetadata(),
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
      resultWorkUnits: result.cursor.workUnits,
      startIndex: cursor.index,
      startWorkUnits: cursor.workUnits,
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

const readWindow = (
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
  const result = readSqlWindowSpecification(
    environment(queryId),
    cursor,
    harness.reader,
  );
  return Object.freeze({ harness, kernel, result });
};

const expressionSql = (
  sql: string,
  result: SqlExpressionResult,
): ReadonlyArray<string> => result.metadata.calls.map((call) =>
  sql.slice(call.range.start, call.range.end)
);

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

const tokenIndexForRange = (
  kernel: SqlParserKernel,
  range: SqlSourceRange,
): number => {
  const index = kernel.tokens.findIndex((token) =>
    token.range.start === range.start && token.range.end === range.end
  );
  assert.notEqual(index, -1, `Missing token at ${String(range.start)}..${String(range.end)}`);
  return index;
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

test("window specifications accept every meaningful ordered section combination", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expressions: ReadonlyArray<string>;
    sql: string;
  }>> = [
    { expressions: [], sql: "" },
    { expressions: [], sql: "base_window" },
    { expressions: ["partition_key"], sql: "PARTITION BY partition_key" },
    { expressions: ["sort_key"], sql: "ORDER BY sort_key" },
    { expressions: [], sql: "RANGE CURRENT ROW" },
    { expressions: ["partition_key", "sort_key"], sql: "PARTITION BY partition_key ORDER BY sort_key" },
    { expressions: ["partition_key"], sql: "PARTITION BY partition_key ROWS CURRENT ROW" },
    { expressions: ["sort_key", "offset_key"], sql: "ORDER BY sort_key GROUPS offset_key PRECEDING" },
    {
      expressions: ["partition_key", "sort_key", "offset_key"],
      sql: "PARTITION BY partition_key ORDER BY sort_key ROWS offset_key PRECEDING",
    },
    {
      expressions: ["partition_key", "sort_key", "lower_key", "upper_key"],
      sql: "base_window PARTITION BY partition_key ORDER BY sort_key RANGE BETWEEN lower_key PRECEDING AND upper_key FOLLOWING",
    },
  ];

  for (const expected of cases) {
    const { result } = readWindow(expected.sql, 61);
    assert.equal(result.cursor.index, result.cursor.endIndex, expected.sql);
    assert.equal(result.cursor.depth, 0, expected.sql);
    assert.deepEqual(expressionSql(expected.sql, result), expected.expressions, expected.sql);
    assert.deepEqual(result.range, { start: 0, end: expected.sql.length }, expected.sql);
  }
});

test("existing window names use PostgreSQL ColId classification", (): void => {
  const accepted: ReadonlyArray<string> = [
    "between",
    "unbounded",
    "following",
    "named_window",
    "\"SELECT\"",
    "\"rows\"",
  ];
  for (const sql of accepted) {
    const { result } = readWindow(sql, 62);
    assert.deepEqual(expressionSql(sql, result), [], sql);
    assert.equal(result.cursor.index, result.cursor.endIndex, sql);
  }

  for (const sql of ["SELECT", "LEFT", "ASC"]) {
    expectParserError(
      () => readWindow(sql, 62),
      "unexpected_token",
      { start: 0, end: sql.length },
      "Unexpected token in PostgreSQL window specification",
    );
  }
});

test("contextual words remain available to expression and sort collaborators", (): void => {
  const sql = [
    "PARTITION BY groups + following, range + rows",
    "ORDER BY using + desc DESC NULLS LAST, rows + preceding USING >",
    "GROUPS boolean_value AND other PRECEDING",
  ].join(" ");
  const { harness, result } = readWindow(sql, 63);

  assert.deepEqual(expressionSql(sql, result), [
    "groups + following",
    "range + rows",
    "using + desc",
    "rows + preceding",
    "boolean_value AND other",
  ]);
  assert.equal(harness.snapshot().calls, 5);
  assert.equal(result.cursor.index, result.cursor.endIndex);
});

test("nested contextual words do not become outer window sections", (): void => {
  const sql = [
    "PARTITION BY outer(order + by, rows + preceding), array_value[groups + following]",
    "ORDER BY sorted(range + preceding) DESC",
    "ROWS (offset_value + 1) PRECEDING",
  ].join(" ");
  const { result } = readWindow(sql, 64);

  assert.deepEqual(expressionSql(sql, result), [
    "outer(order + by, rows + preceding)",
    "array_value[groups + following]",
    "sorted(range + preceding)",
  ]);
  assert.equal(result.cursor.index, result.cursor.endIndex);
});

test("window specifications reject missing, duplicate, late, and leftover sections", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      message: "PARTITION requires BY in a window specification",
      range: { start: 10, end: 15 },
      sql: "PARTITION value",
    },
    {
      message: "ORDER requires BY in a window specification",
      range: { start: 6, end: 11 },
      sql: "ORDER value",
    },
    {
      message: "Window specification cannot contain more than one PARTITION BY clause",
      range: { start: 15, end: 24 },
      sql: "PARTITION BY a PARTITION BY b",
    },
    {
      message: "PARTITION BY must appear before ORDER BY and the window frame clause",
      range: { start: 11, end: 20 },
      sql: "ORDER BY a PARTITION BY b",
    },
    {
      message: "Window specification cannot contain more than one ORDER BY clause",
      range: { start: 11, end: 16 },
      sql: "ORDER BY a ORDER BY b",
    },
    {
      message: "Unexpected token after the window frame clause",
      range: { start: 17, end: 22 },
      sql: "ROWS 1 PRECEDING ORDER BY a",
    },
    {
      message: "Unexpected token after the window frame clause",
      range: { start: 17, end: 22 },
      sql: "ROWS 1 PRECEDING RANGE 2 PRECEDING",
    },
    {
      message: "Unexpected token in PostgreSQL window specification",
      range: { start: 13, end: 23 },
      sql: "named_window unexpected",
    },
    {
      message: "Unexpected token in PostgreSQL window specification",
      range: { start: 15, end: 20 },
      sql: "PARTITION BY a extra",
    },
    {
      message: "Unexpected token in PostgreSQL window specification",
      range: { start: 11, end: 16 },
      sql: "ORDER BY a extra",
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => readWindow(invalid.sql, 65),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("window specifications reject empty items and malformed separators", (): void => {
  const cases: ReadonlyArray<Readonly<{
    calls: number;
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      calls: 0,
      message: "PARTITION BY requires at least one expression",
      range: { start: 12, end: 12 },
      sql: "PARTITION BY",
    },
    {
      calls: 0,
      message: "PARTITION BY item requires an expression before comma",
      range: { start: 13, end: 14 },
      sql: "PARTITION BY , value",
    },
    {
      calls: 1,
      message: "PARTITION BY item requires an expression before comma",
      range: { start: 15, end: 16 },
      sql: "PARTITION BY a,, value",
    },
    {
      calls: 1,
      message: "PARTITION BY cannot end with a comma",
      range: { start: 14, end: 15 },
      sql: "PARTITION BY a,",
    },
    {
      calls: 1,
      message: "PARTITION BY cannot end with a comma",
      range: { start: 14, end: 15 },
      sql: "PARTITION BY a, ORDER BY value",
    },
    {
      calls: 1,
      message: "PARTITION BY cannot end with a comma",
      range: { start: 14, end: 15 },
      sql: "PARTITION BY a, PARTITION BY value",
    },
    {
      calls: 0,
      message: "ORDER BY requires at least one expression",
      range: { start: 8, end: 8 },
      sql: "ORDER BY",
    },
    {
      calls: 0,
      message: "ORDER BY item requires an expression before comma",
      range: { start: 9, end: 10 },
      sql: "ORDER BY , value",
    },
    {
      calls: 1,
      message: "ORDER BY cannot end with a comma",
      range: { start: 10, end: 11 },
      sql: "ORDER BY a,",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlWindowSpecification(
        environment(66),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
    assert.equal(harness.snapshot().calls, invalid.calls, invalid.sql);
  }
});

test("bounded parents preserve exact offsets, depth, metadata, and cumulative work", (): void => {
  const sql = [
    "prefix",
    "base_window PARTITION BY partition_one, partition_two",
    "ORDER BY sort_one DESC",
    "ROWS offset_one PRECEDING",
    "trailing",
  ].join(" ");
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const state = createSqlReadState(kernel);
  const parent = enterSqlReadDepth(
    createSqlReadCursor(state, 1, kernel.tokens.length - 1),
    "Enter bounded window test parent",
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowSpecification(
    environment(67),
    parent,
    harness.reader,
  );
  const expectedExpressions = [
    "partition_one",
    "partition_two",
    "sort_one",
    "offset_one",
  ];
  const snapshot = harness.snapshot();

  assert.equal(result.cursor.state, parent.state);
  assert.equal(result.cursor.index, parent.endIndex);
  assert.equal(result.cursor.endIndex, parent.endIndex);
  assert.equal(result.cursor.depth, parent.depth);
  assert.deepEqual(result.range, {
    start: sourceRange(sql, "base_window", 0).start,
    end: sourceRange(sql, "PRECEDING", 0).end,
  });
  assert.deepEqual(expressionSql(sql, result), expectedExpressions);
  assert.equal(result.metadata.nestedQueries.length, expectedExpressions.length);
  assert.equal(result.metadata.typeConstructs.length, expectedExpressions.length);
  assert.equal(Object.isFrozen(result.metadata.calls), true);
  assert.equal(Object.isFrozen(result.metadata.nestedQueries), true);
  assert.equal(Object.isFrozen(result.metadata.typeConstructs), true);
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.depth),
    expectedExpressions.map(() => parent.depth + 1),
  );
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.endIndex),
    expectedExpressions.map(() => parent.endIndex),
  );
  assert.equal(result.cursor.workUnits > parent.workUnits, true);
});

test("PARTITION BY delegates each expression exactly once with monotone cursors", (): void => {
  const sql = "PARTITION BY first + 1, second, third + fourth, fifth";
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowSpecification(
    environment(68),
    cursor,
    harness.reader,
  );
  const snapshot = harness.snapshot();

  assert.equal(snapshot.calls, 4);
  assert.deepEqual(expressionSql(sql, result), [
    "first + 1",
    "second",
    "third + fourth",
    "fifth",
  ]);
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.startIndex),
    ["first", "second", "third", "fifth"].map((word) =>
      tokenIndexForRange(kernel, sourceRange(sql, word, 0))
    ),
  );
  for (const [index, invocation] of snapshot.invocations.entries()) {
    assert.equal(invocation.resultIndex > invocation.startIndex, true);
    assert.equal(invocation.resultWorkUnits > invocation.startWorkUnits, true);
    if (index > 0) {
      const previous = snapshot.invocations[index - 1];
      assert.notEqual(previous, undefined);
      assert.equal(previous.resultIndex < invocation.startIndex, true);
      assert.equal(previous.resultWorkUnits < invocation.startWorkUnits, true);
    }
  }
  assert.equal(
    snapshot.lastReturnedWorkUnits !== null
      && result.cursor.workUnits > snapshot.lastReturnedWorkUnits,
    true,
  );
});

test("outer reader never probes contextual sort or frame boundaries", (): void => {
  const sql = "ORDER BY rows + preceding DESC ROWS boolean_value AND other PRECEDING";
  const { harness, result } = readWindow(sql, 69);
  const snapshot = harness.snapshot();

  assert.deepEqual(expressionSql(sql, result), [
    "rows + preceding",
    "boolean_value AND other",
  ]);
  assert.equal(snapshot.calls, 2);
  assert.equal(snapshot.invocations.length, 2);
  assert.equal(snapshot.invocations[0]?.resultIndex < snapshot.invocations[1]?.startIndex, true);
});

test("empty partition collaborator results fail as cursor invariants", (): void => {
  const sql = "PARTITION BY value";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const emptyReader: SqlExpressionPrefixReader = (
    _expressionEnvironment: SqlExpressionEnvironment,
    expressionCursor: SqlReadCursor,
  ): SqlExpressionResult => Object.freeze({
    cursor: expressionCursor,
    metadata: emptyMetadata(),
    range: sqlReadRangeForSpan(
      expressionCursor.state,
      expressionCursor.index,
      expressionCursor.index,
    ),
  });

  expectParserError(
    () => readSqlWindowSpecification(environment(70), cursor, emptyReader),
    "internal_invariant",
    sourceRange(sql, "value", 0),
    "PARTITION BY expression prefix reader returned an empty expression",
  );
});

test("large partition lists retain ordered metadata and linear cursor work", (): void => {
  const count = 2_000;
  const sql = `PARTITION BY ${Array.from(
    { length: count },
    (_unused, index) => `item_${String(index)}`,
  ).join(",")}`;
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlWindowSpecification(
    environment(71),
    cursor,
    harness.reader,
  );
  const snapshot = harness.snapshot();
  const totalWork = result.cursor.workUnits - cursor.workUnits;

  assert.equal(snapshot.calls, count);
  assert.equal(snapshot.invocations.length, count);
  assert.equal(result.metadata.calls.length, count);
  assert.equal(expressionSql(sql, result)[0], "item_0");
  assert.equal(expressionSql(sql, result).at(-1), `item_${String(count - 1)}`);
  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(totalWork < kernel.tokens.length * 20, true);
});

test("window work accepts its measured exact maximum and fails on first excess", (): void => {
  const sql = "PARTITION BY first, second ORDER BY sorted DESC ROWS offset PRECEDING";
  const ample = createReadCursor(
    sql,
    limits(sql.length, 30, 4, 1_000),
  );
  const ampleHarness = createPrefixReaderHarness();
  const measured = readSqlWindowSpecification(
    environment(72),
    ample.cursor,
    ampleHarness.reader,
  );
  const exactLimit = measured.cursor.workUnits;

  const exact = createReadCursor(
    sql,
    limits(sql.length, 30, 4, exactLimit),
  );
  const exactHarness = createPrefixReaderHarness();
  const exactResult = readSqlWindowSpecification(
    environment(72),
    exact.cursor,
    exactHarness.reader,
  );
  assert.equal(exactResult.cursor.workUnits, exactLimit);

  const firstExcess = createReadCursor(
    sql,
    limits(sql.length, 30, 4, exactLimit - 1),
  );
  const firstExcessHarness = createPrefixReaderHarness();
  assert.throws(
    () => readSqlWindowSpecification(
      environment(72),
      firstExcess.cursor,
      firstExcessHarness.reader,
    ),
    (error: unknown): boolean => {
      assert.ok(error instanceof SqlPolicyParserError);
      assert.equal(error.code, "limit_complexity");
      return true;
    },
  );
});
