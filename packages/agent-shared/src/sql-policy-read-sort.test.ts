import assert from "node:assert/strict";
import test from "node:test";
import type {
  SqlIdentifierToken,
  SqlSourceRange,
} from "./sql-policy-lexer.js";
import {
  createSqlParserKernel,
  DEFAULT_SQL_PARSER_LIMITS,
  type SqlParserKernel,
  type SqlParserLimits,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  throwSqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";
import type {
  SqlExpressionEnvironment,
  SqlExpressionReader,
  SqlExpressionResult,
} from "./sql-policy-read-expression.js";
import type {
  SqlCallNode,
  SqlExpressionMetadata,
  SqlNestedQueryNode,
  SqlTypeConstructNode,
} from "./sql-policy-read-model.js";
import type { SqlTypeNameNode } from "./sql-policy-type-model.js";
import {
  advanceSqlReadCursor,
  createSqlReadCursor,
  createSqlReadState,
  enterSqlReadDepth,
  inspectSqlReadToken,
  sqlReadRangeForSpan,
  type SqlReadCursor,
} from "./sql-policy-read-state.js";
import { readSqlSortList } from "./sql-policy-read-sort.js";

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
): SqlExpressionMetadata => {
  const call: SqlCallNode = Object.freeze({
    argumentsRange: range,
    context: expressionEnvironment.context,
    path: Object.freeze([token]),
    queryId: expressionEnvironment.queryId,
    range,
    syntaxContext: expressionEnvironment.syntaxContext,
  });
  return Object.freeze({
    calls: Object.freeze([call]),
    nestedQueries: Object.freeze([]),
    typeConstructs: Object.freeze([]),
  });
};

const readMinimalExpression: SqlExpressionReader<SqlExpressionResult> = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const startIndex = cursor.index;
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect deterministic test expression",
  );
  if (inspected.token === undefined) {
    return throwSqlPolicyParserError(
      "unexpected_token",
      "Deterministic test expression reader requires a token",
      sqlReadRangeForSpan(cursor.state, startIndex, startIndex),
    );
  }
  const range = sqlReadRangeForSpan(
    cursor.state,
    startIndex,
    cursor.endIndex,
  );
  const advanced = advanceSqlReadCursor(
    inspected.cursor,
    cursor.endIndex - cursor.index,
    "Consume deterministic test expression",
  );
  return Object.freeze({
    cursor: advanced,
    metadata: inspected.token.kind === "identifier"
      ? callMetadata(expressionEnvironment, inspected.token, range)
      : emptyMetadata(),
    range,
  });
};

const readRichMetadataExpression: SqlExpressionReader<SqlExpressionResult> = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const result = readMinimalExpression(expressionEnvironment, cursor);
  const call = result.metadata.calls[0];
  const name = call?.path[0];
  if (call === undefined || name === undefined) {
    return result;
  }
  const sql = cursor.state.kernel.sql.slice(
    result.range.start,
    result.range.end,
  );
  const nestedQuery: SqlNestedQueryNode = Object.freeze({
    bodyRange: result.range,
    context: "nested",
    endIndex: result.cursor.index,
    kind: "expression",
    parentQueryId: expressionEnvironment.queryId,
    range: result.range,
    startIndex: cursor.index,
  });
  const typeName: SqlTypeNameNode = Object.freeze({
    arrayBounds: Object.freeze([]),
    form: "generic",
    intervalQualifier: null,
    modifiers: Object.freeze([]),
    nameParts: Object.freeze([name]),
    nameRange: name.range,
    range: result.range,
    setOf: false,
    sql,
    timeZone: null,
  });
  const typeConstruct: SqlTypeConstructNode = Object.freeze({
    context: expressionEnvironment.context,
    queryId: expressionEnvironment.queryId,
    range: result.range,
    syntax: "cast",
    typeName,
  });
  return Object.freeze({
    ...result,
    metadata: Object.freeze({
      calls: result.metadata.calls,
      nestedQueries: Object.freeze([nestedQuery]),
      typeConstructs: Object.freeze([typeConstruct]),
    }),
  });
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

const normalizedCalls = (
  result: SqlExpressionResult,
): ReadonlyArray<string> => result.metadata.calls.map((call) =>
  call.path.map((part) => part.untruncatedNormalized).join(".")
);

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

test("ORDER BY reads expressions, direction, USING, and NULLS suffixes", (): void => {
  const sql = [
    "alpha DESC NULLS LAST",
    "beta USING > NULLS FIRST",
    "qualified USING OPERATOR(pg_catalog.<) NULLS LAST",
    "gamma ASC",
    "delta",
  ].join(", ");
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlSortList(
    environment(21),
    cursor,
    readMinimalExpression,
  );

  assert.equal(result.cursor.index, cursor.endIndex);
  assert.equal(result.cursor.endIndex, cursor.endIndex);
  assert.equal(result.cursor.depth, cursor.depth);
  assert.equal(result.cursor.state, cursor.state);
  assert.equal(result.range.start, 0);
  assert.equal(result.range.end, sql.length);
  assert.deepEqual(normalizedCalls(result), [
    "alpha",
    "beta",
    "qualified",
    "gamma",
    "delta",
  ]);
  assert.deepEqual(
    result.metadata.calls.map((call) => sql.slice(
      call.range.start,
      call.range.end,
    )),
    ["alpha", "beta", "qualified", "gamma", "delta"],
  );
});

test("ORDER BY keeps contextual NULLS identifiers inside expressions", (): void => {
  const sql = "nulls, nulls DESC, value NULLS FIRST";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlSortList(
    environment(25),
    cursor,
    readMinimalExpression,
  );

  assert.deepEqual(normalizedCalls(result), ["nulls", "nulls", "value"]);
  assert.deepEqual(
    result.metadata.calls.map((call) => sql.slice(
      call.range.start,
      call.range.end,
    )),
    ["nulls", "nulls", "value"],
  );
});

test("ORDER BY keeps contextual direction words inside expressions", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expressions: ReadonlyArray<string>;
    sql: string;
  }>> = [
    { expressions: ["ASC"], sql: "ASC" },
    { expressions: ["DESC"], sql: "DESC" },
    { expressions: ["USING"], sql: "USING" },
    {
      expressions: ["asc", "desc", "using"],
      sql: "asc, desc, using",
    },
    {
      expressions: ["alpha USING first"],
      sql: "alpha USING first",
    },
    {
      expressions: ["foo + asc"],
      sql: "foo + asc DESC",
    },
    {
      expressions: ["foo + desc"],
      sql: "foo + desc NULLS LAST",
    },
    {
      expressions: ["foo + using"],
      sql: "foo + using ASC",
    },
    {
      expressions: ["foo + using"],
      sql: "foo + using NULLS FIRST",
    },
  ];

  for (const expected of cases) {
    const { cursor } = createReadCursor(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const result = readSqlSortList(
      environment(27),
      cursor,
      readMinimalExpression,
    );
    assert.deepEqual(
      result.metadata.calls.map((call) => expected.sql.slice(
        call.range.start,
        call.range.end,
      )),
      expected.expressions,
      expected.sql,
    );
    assert.equal(result.cursor.index, cursor.endIndex, expected.sql);
  }
});

test("ORDER BY recognizes terminal field wildcards before suffixes", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expression: string;
    sql: string;
  }>> = [
    {
      expression: "row_value.*",
      sql: "row_value.* DESC",
    },
    {
      expression: "(row_value).*",
      sql: "(row_value).* ASC NULLS FIRST",
    },
    {
      expression: "row_value.*",
      sql: "row_value.* USING < NULLS LAST",
    },
    {
      expression: "row_value.*",
      sql: "row_value.* NULLS FIRST",
    },
    {
      expression: "(row_value).*",
      sql: "(row_value).* USING <",
    },
  ];

  for (const expected of cases) {
    const expressions: Array<string> = [];
    const { cursor } = createReadCursor(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const recordingReader: SqlExpressionReader<SqlExpressionResult> = (
      expressionEnvironment: SqlExpressionEnvironment,
      child: SqlReadCursor,
    ): SqlExpressionResult => {
      const range = sqlReadRangeForSpan(
        child.state,
        child.index,
        child.endIndex,
      );
      expressions.push(expected.sql.slice(range.start, range.end));
      return readMinimalExpression(expressionEnvironment, child);
    };
    const result = readSqlSortList(
      environment(30),
      cursor,
      recordingReader,
    );

    assert.deepEqual(expressions, [expected.expression], expected.sql);
    assert.equal(result.cursor.index, cursor.endIndex, expected.sql);
  }
});

test("ORDER BY does not confuse multiplication or incomplete dots with field wildcards", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expression: string;
    sql: string;
  }>> = [
    {
      expression: "left_value * right_value",
      sql: "left_value * right_value DESC",
    },
    {
      expression: "left_value * DESC",
      sql: "left_value * DESC",
    },
    {
      expression: "(left_value) * USING <",
      sql: "(left_value) * USING <",
    },
    {
      expression: "row_value. DESC",
      sql: "row_value. DESC",
    },
    {
      expression: ".* ASC",
      sql: ".* ASC",
    },
    {
      expression: "row_value.*. USING <",
      sql: "row_value.*. USING <",
    },
    {
      expression: "row_value.* * right_value",
      sql: "row_value.* * right_value DESC",
    },
  ];

  for (const expected of cases) {
    const expressions: Array<string> = [];
    const { cursor } = createReadCursor(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const recordingReader: SqlExpressionReader<SqlExpressionResult> = (
      expressionEnvironment: SqlExpressionEnvironment,
      child: SqlReadCursor,
    ): SqlExpressionResult => {
      const range = sqlReadRangeForSpan(
        child.state,
        child.index,
        child.endIndex,
      );
      expressions.push(expected.sql.slice(range.start, range.end));
      return readMinimalExpression(expressionEnvironment, child);
    };
    const result = readSqlSortList(
      environment(30),
      cursor,
      recordingReader,
    );

    assert.deepEqual(expressions, [expected.expression], expected.sql);
    assert.equal(result.cursor.index, cursor.endIndex, expected.sql);
  }
});

test("ORDER BY ignores nested commas and suffix keywords", (): void => {
  const sql = [
    "outer_fn(inner DESC, other NULLS FIRST) DESC NULLS LAST",
    "array_value[using, asc, nested(desc)] USING <",
  ].join(", ");
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlSortList(
    environment(22),
    cursor,
    readMinimalExpression,
  );

  assert.deepEqual(normalizedCalls(result), ["outer_fn", "array_value"]);
  assert.deepEqual(
    result.metadata.calls.map((call) => sql.slice(
      call.range.start,
      call.range.end,
    )),
    [
      "outer_fn(inner DESC, other NULLS FIRST)",
      "array_value[using, asc, nested(desc)]",
    ],
  );
});

test("ORDER BY rejects empty and malformed items at the exact token", (): void => {
  const cases: ReadonlyArray<Readonly<{
    sql: string;
    range: SqlSourceRange;
    message: string;
  }>> = [
    {
      message: "ORDER BY requires at least one expression",
      range: { start: 0, end: 0 },
      sql: "",
    },
    {
      message: "ORDER BY item requires an expression before comma",
      range: { start: 0, end: 1 },
      sql: ", alpha",
    },
    {
      message: "ORDER BY cannot end with a comma",
      range: { start: 5, end: 6 },
      sql: "alpha,",
    },
    {
      message: "ORDER BY item requires an expression before comma",
      range: { start: 7, end: 8 },
      sql: "alpha, , beta",
    },
    {
      message: "Expected a comma between ORDER BY items",
      range: { start: 11, end: 15 },
      sql: "alpha DESC beta",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    expectParserError(
      () => readSqlSortList(
        environment(23),
        cursor,
        readMinimalExpression,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("ORDER BY rejects missing and misordered suffix components", (): void => {
  const cases: ReadonlyArray<Readonly<{
    sql: string;
    range: SqlSourceRange;
    message: string;
  }>> = [
    {
      message: "ORDER BY NULLS requires FIRST or LAST",
      range: { start: 16, end: 16 },
      sql: "alpha DESC NULLS",
    },
    {
      message: "ORDER BY NULLS requires FIRST or LAST",
      range: { start: 17, end: 23 },
      sql: "alpha DESC NULLS middle",
    },
    {
      message: "DESC must appear before NULLS ordering in an ORDER BY item",
      range: { start: 18, end: 22 },
      sql: "alpha NULLS FIRST DESC",
    },
    {
      message: "ORDER BY item cannot contain more than one ASC, DESC, or USING clause",
      range: { start: 10, end: 15 },
      sql: "alpha ASC USING >",
    },
    {
      message: "ORDER BY item cannot contain more than one ASC, DESC, or USING clause",
      range: { start: 11, end: 14 },
      sql: "alpha DESC ASC",
    },
    {
      message: "ORDER BY item cannot contain more than one NULLS clause",
      range: { start: 18, end: 23 },
      sql: "alpha NULLS FIRST NULLS LAST",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    expectParserError(
      () => readSqlSortList(
        environment(24),
        cursor,
        readMinimalExpression,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("ORDER BY validates qualified OPERATOR names exactly", (): void => {
  const cases: ReadonlyArray<Readonly<{
    sql: string;
    range: SqlSourceRange;
    message: string;
  }>> = [
    {
      message: "ORDER BY USING OPERATOR requires an opening parenthesis",
      range: { start: 20, end: 20 },
      sql: "value USING OPERATOR",
    },
    {
      message: "ORDER BY USING OPERATOR requires an opening parenthesis",
      range: { start: 20, end: 21 },
      sql: "value USING OPERATOR[<]",
    },
    {
      message: "ORDER BY USING OPERATOR requires an operator name",
      range: { start: 21, end: 21 },
      sql: "value USING OPERATOR()",
    },
    {
      message: "ORDER BY USING OPERATOR qualifier requires a following dot",
      range: { start: 31, end: 31 },
      sql: "value USING OPERATOR(pg_catalog)",
    },
    {
      message: "ORDER BY USING OPERATOR requires dot-separated PostgreSQL identifiers followed by an operator name",
      range: { start: 21, end: 27 },
      sql: "value USING OPERATOR(select.<)",
    },
    {
      message: "ORDER BY USING OPERATOR cannot contain tokens after the operator name",
      range: { start: 34, end: 39 },
      sql: "value USING OPERATOR(pg_catalog.< extra)",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    expectParserError(
      () => readSqlSortList(
        environment(26),
        cursor,
        readMinimalExpression,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("ORDER BY rejects operators outside PostgreSQL all_Op", (): void => {
  const specialOperators: ReadonlyArray<string> = ["::", ":=", "..", "=>"];

  for (const operator of specialOperators) {
    const directSql = `value USING ${operator}`;
    const direct = createReadCursor(
      directSql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    expectParserError(
      () => readSqlSortList(
        environment(28),
        direct.cursor,
        readMinimalExpression,
      ),
      "unexpected_token",
      { start: 12, end: 14 },
      `ORDER BY USING requires a PostgreSQL all_Op operator; "${operator}" is reserved syntax`,
    );

    const qualifiedSql = `value USING OPERATOR(pg_catalog. ${operator})`;
    const qualified = createReadCursor(
      qualifiedSql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    expectParserError(
      () => readSqlSortList(
        environment(28),
        qualified.cursor,
        readMinimalExpression,
      ),
      "unexpected_token",
      { start: 33, end: 35 },
      `ORDER BY USING OPERATOR requires a PostgreSQL all_Op operator; "${operator}" is reserved syntax`,
    );
  }
});

test("ORDER BY accepts neighboring PostgreSQL all_Op operators", (): void => {
  const accepted: ReadonlyArray<string> = [
    "value USING =",
    "value USING ->",
    "value USING ?",
    "value USING OPERATOR(pg_catalog.=)",
    "value USING OPERATOR(pg_catalog.->)",
    "value USING OPERATOR(?)",
  ];

  for (const sql of accepted) {
    const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
    const result = readSqlSortList(
      environment(29),
      cursor,
      readMinimalExpression,
    );
    assert.equal(result.cursor.index, cursor.endIndex, sql);
    assert.deepEqual(normalizedCalls(result), ["value"], sql);
  }
});

test("ORDER BY preserves every child metadata collection in order", (): void => {
  const sql = "first, second DESC, third USING >";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlSortList(
    environment(35),
    cursor,
    readRichMetadataExpression,
  );
  const expected = ["first", "second", "third"];

  assert.deepEqual(normalizedCalls(result), expected);
  assert.equal(result.metadata.nestedQueries.length, expected.length);
  assert.equal(result.metadata.typeConstructs.length, expected.length);
  assert.deepEqual(
    result.metadata.typeConstructs.map((construct) =>
      construct.typeName.nameParts[0]?.untruncatedNormalized
    ),
    expected,
  );
  assert.equal(Object.isFrozen(result.metadata.calls), true);
  assert.equal(Object.isFrozen(result.metadata.nestedQueries), true);
  assert.equal(Object.isFrozen(result.metadata.typeConstructs), true);
});

test("bounded parent cursors and deeper child cursors resume exactly", (): void => {
  const sql = "prefix alpha DESC trailing";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const state = createSqlReadState(kernel);
  const parent = enterSqlReadDepth(
    createSqlReadCursor(state, 1, kernel.tokens.length - 1),
    "Enter bounded test parent",
  );
  const deeperReader: SqlExpressionReader<SqlExpressionResult> = (
    expressionEnvironment: SqlExpressionEnvironment,
    cursor: SqlReadCursor,
  ): SqlExpressionResult => readMinimalExpression(
    expressionEnvironment,
    enterSqlReadDepth(cursor, "Enter deterministic child depth"),
  );
  const result = readSqlSortList(
    environment(41),
    parent,
    deeperReader,
  );

  assert.equal(result.cursor.state, parent.state);
  assert.equal(result.cursor.index, parent.endIndex);
  assert.equal(result.cursor.endIndex, parent.endIndex);
  assert.equal(result.cursor.depth, parent.depth);
  assert.equal(result.range.start, 7);
  assert.equal(result.range.end, 17);
  assert.equal(result.cursor.workUnits > parent.workUnits, true);
});

test("delimiter scanning enforces read depth at the opening token", (): void => {
  const sql = "outer(inner DESC) ASC";
  const parserLimits = limits(sql.length, 20, 1, 200);
  const { cursor } = createReadCursor(sql, parserLimits);
  const nestedParent = enterSqlReadDepth(cursor, "Fill test read depth");

  expectParserError(
    () => readSqlSortList(
      environment(42),
      nestedParent,
      readMinimalExpression,
    ),
    "limit_nesting",
    { start: 5, end: 6 },
    "Scan ORDER BY expression nesting nesting depth 2 exceeds maxNestingDepth=1",
  );
});

test("qualified OPERATOR enforces delimiter bounds and restores read depth", (): void => {
  const sql = "value USING OPERATOR(pg_catalog.<)";
  const boundedKernel = createSqlParserKernel(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const boundedState = createSqlReadState(boundedKernel);
  const bounded = createSqlReadCursor(
    boundedState,
    0,
    boundedKernel.tokens.length - 1,
  );
  expectParserError(
    () => readSqlSortList(
      environment(47),
      bounded,
      readMinimalExpression,
    ),
    "unexpected_token",
    { start: 20, end: 21 },
    "Match ORDER BY USING OPERATOR parentheses closes outside the current parse range",
  );

  const depthLimits = limits(sql.length, 20, 1, 200);
  const { cursor } = createReadCursor(sql, depthLimits);
  const result = readSqlSortList(
    environment(47),
    cursor,
    readMinimalExpression,
  );
  assert.equal(result.cursor.index, cursor.endIndex);
  assert.equal(result.cursor.endIndex, cursor.endIndex);
  assert.equal(result.cursor.depth, cursor.depth);
});

test("qualified OPERATOR reports the low-limit first excess at lookup", (): void => {
  const sql = "value USING OPERATOR(pg_catalog.<)";
  const { cursor } = createReadCursor(
    sql,
    limits(sql.length, 20, 3, 19),
  );
  expectParserError(
    () => readSqlSortList(
      environment(48),
      cursor,
      readMinimalExpression,
    ),
    "limit_complexity",
    { start: 20, end: 21 },
    "SQL parser Match ORDER BY USING OPERATOR parentheses exceeded maxWorkUnits=19 at token 3",
  );
});

test("expression collaborators must consume their exact bounded span", (): void => {
  const sql = "alpha DESC";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const partialReader: SqlExpressionReader<SqlExpressionResult> = (
    _expressionEnvironment: SqlExpressionEnvironment,
    child: SqlReadCursor,
  ): SqlExpressionResult => Object.freeze({
    cursor: child,
    metadata: emptyMetadata(),
    range: sqlReadRangeForSpan(child.state, child.index, child.index),
  });

  expectParserError(
    () => readSqlSortList(
      environment(43),
      cursor,
      partialReader,
    ),
    "internal_invariant",
    { start: 0, end: 5 },
    "ORDER BY expression reader returned cursor 0..1 but the exact expression span ends at token 1",
  );
});

test("runtime work accepts the exact maximum and fails at first excess", (): void => {
  const sql = "value";
  const ample = createReadCursor(
    sql,
    limits(sql.length, 5, 2, 100),
  );
  const measured = readSqlSortList(
    environment(44),
    ample.cursor,
    readMinimalExpression,
  );
  const exactLimit = measured.cursor.workUnits;

  const exact = createReadCursor(
    sql,
    limits(sql.length, 5, 2, exactLimit),
  );
  const exactResult = readSqlSortList(
    environment(44),
    exact.cursor,
    readMinimalExpression,
  );
  assert.equal(exactResult.cursor.workUnits, exactLimit);

  const firstExcess = createReadCursor(
    sql,
    limits(sql.length, 5, 2, exactLimit - 1),
  );
  expectParserError(
    () => readSqlSortList(
      environment(44),
      firstExcess.cursor,
      readMinimalExpression,
    ),
    "limit_complexity",
    { start: sql.length, end: sql.length },
    `SQL parser Inspect ORDER BY item terminator exceeded maxWorkUnits=${String(exactLimit - 1)} at token 1`,
  );
});

test("large ORDER BY metadata aggregation remains ordered and iterative", (): void => {
  const count = 2_000;
  const sql = Array.from(
    { length: count },
    (_unused, index) => `item_${String(index)}`,
  ).join(",");
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlSortList(
    environment(45),
    cursor,
    readMinimalExpression,
  );

  assert.equal(result.metadata.calls.length, count);
  assert.equal(normalizedCalls(result)[0], "item_0");
  assert.equal(normalizedCalls(result).at(-1), `item_${String(count - 1)}`);
  assert.equal(result.cursor.index, cursor.endIndex);
});
