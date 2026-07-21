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
import {
  readSqlSortList,
  readSqlSortListPrefix,
} from "./sql-policy-read-sort.js";

type PrefixReaderInvocation = Readonly<{
  depth: number;
  endIndex: number;
  resultWorkUnits: number;
  resultIndex: number;
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

const isPrefixOpeningDelimiter = (token: SqlParserToken): boolean =>
  token.text === "(" || token.text === "[";

const isPrefixUnaryOperator = (token: SqlParserToken): boolean =>
  token.kind === "operator"
  && (token.text === "+" || token.text === "-" || token.text === "~");

const isPrefixBooleanOperator = (word: string | null): boolean =>
  word === "and" || word === "or";

const isPrefixExpressionAtom = (token: SqlParserToken): boolean =>
  (
    token.kind === "identifier"
    && !isPrefixBooleanOperator(postgreSqlTokenWord(token))
  )
  || token.kind === "numeric"
  || token.kind === "parameter"
  || token.kind === "string";

const readDeterministicNestedExpression = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = readDeterministicPrefixPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic nested sort expression continuation",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      return current;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (
      inspected.token.kind !== "operator"
      && !isPrefixBooleanOperator(word)
    ) {
      return deterministicPrefixError(
        current,
        "Deterministic nested sort expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic nested sort expression operator",
    ).cursor;
    current = readDeterministicPrefixPrimary(current);
  }
};

const readDeterministicPrefixDelimiter = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter deterministic sort prefix-expression delimiter",
  );
  const matched = matchingSqlReadDelimiter(
    nested,
    "Match deterministic sort prefix-expression delimiter",
  );
  const afterOpening = advanceSqlReadCursor(
    matched.cursor,
    1,
    "Consume deterministic sort prefix-expression opening delimiter",
  );
  let current = narrowSqlReadCursor(
    afterOpening,
    matched.closeIndex,
    "Bound deterministic sort prefix-expression delimiter contents",
  );
  let itemCount = 0;

  while (true) {
    const item = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort delimiter item",
    );
    current = item.cursor;
    if (item.token === undefined) {
      if (itemCount === 0) {
        return deterministicPrefixError(
          current,
          "Deterministic grouped sort expression cannot be empty",
        );
      }
      break;
    }

    current = readDeterministicNestedExpression(current);
    itemCount++;
    const separator = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort delimiter separator",
    );
    current = separator.cursor;
    if (separator.token === undefined) {
      break;
    }
    if (separator.token.text !== ",") {
      return deterministicPrefixError(
        current,
        "Deterministic nested sort expression has a trailing token",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic sort delimiter comma",
    ).cursor;
    const next = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort delimiter item after comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return deterministicPrefixError(
        current,
        "Deterministic sort delimiter requires an expression after comma",
      );
    }
  }

  const atClosing = resumeSqlReadCursor(
    matched.cursor,
    current,
    "Resume deterministic sort prefix-expression delimiter contents",
  );
  const afterClosing = consumeSqlReadToken(
    atClosing,
    "Consume deterministic sort prefix-expression closing delimiter",
  ).cursor;
  return resumeSqlReadCursor(
    cursor,
    afterClosing,
    "Resume deterministic sort prefix-expression delimiter",
  );
};

const readDeterministicPrefixPostfix = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort expression postfix",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return current;
    }
    if (isPrefixOpeningDelimiter(inspected.token)) {
      current = readDeterministicPrefixDelimiter(current);
      continue;
    }
    if (inspected.token.text !== ".") {
      return current;
    }

    current = consumeSqlReadToken(
      current,
      "Consume deterministic sort expression field dot",
    ).cursor;
    const field = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort expression field",
    );
    current = field.cursor;
    if (
      field.token?.kind !== "identifier"
      && !(field.token?.kind === "operator" && field.token.text === "*")
    ) {
      return deterministicPrefixError(
        current,
        "Deterministic sort expression field selection is incomplete",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic sort expression field",
    ).cursor;
  }
};

const readDeterministicPrefixPrimary = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort expression primary",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return deterministicPrefixError(
        current,
        "Deterministic sort prefix expression requires an operand",
      );
    }
    if (isPrefixUnaryOperator(inspected.token)) {
      current = consumeSqlReadToken(
        current,
        "Consume deterministic sort expression unary operator",
      ).cursor;
      continue;
    }
    if (isPrefixOpeningDelimiter(inspected.token)) {
      return readDeterministicPrefixPostfix(
        readDeterministicPrefixDelimiter(current),
      );
    }
    if (!isPrefixExpressionAtom(inspected.token)) {
      return deterministicPrefixError(
        current,
        "Deterministic sort prefix expression requires an operand",
      );
    }
    return readDeterministicPrefixPostfix(consumeSqlReadToken(
      current,
      "Consume deterministic sort expression atom",
    ).cursor);
  }
};

const prefixExpressionMetadata = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  endIndex: number,
  range: SqlSourceRange,
): SqlExpressionMetadata => {
  const token = cursor.state.kernel.tokens[cursor.index];
  if (token?.kind !== "identifier") {
    return emptyMetadata();
  }
  const call = callMetadata(expressionEnvironment, token, range).calls[0];
  if (call === undefined) {
    return emptyMetadata();
  }
  const nestedQuery: SqlNestedQueryNode = Object.freeze({
    bodyRange: range,
    context: "nested",
    endIndex,
    kind: "expression",
    parentQueryId: expressionEnvironment.queryId,
    range,
    startIndex: cursor.index,
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
    sql: cursor.state.kernel.sql.slice(range.start, range.end),
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

const readDeterministicExpressionPrefix = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const startIndex = cursor.index;
  let current = readDeterministicPrefixPrimary(cursor);
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic sort expression continuation",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      break;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (
      inspected.token.kind !== "operator"
      && !isPrefixBooleanOperator(word)
    ) {
      break;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic sort expression operator",
    ).cursor;
    current = readDeterministicPrefixPrimary(current);
  }

  const range = sqlReadRangeForSpan(
    cursor.state,
    startIndex,
    current.index,
  );
  return Object.freeze({
    cursor: current,
    metadata: prefixExpressionMetadata(
      expressionEnvironment,
      cursor,
      current.index,
      range,
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

const normalizedCalls = (
  result: SqlExpressionResult,
): ReadonlyArray<string> => result.metadata.calls.map((call) =>
  call.path.map((part) => part.untruncatedNormalized).join(".")
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

test("prefix ORDER BY reads every suffix form and leaves caller terminators", (): void => {
  const terminators: ReadonlyArray<string> = [
    "RANGE",
    "ROWS",
    "GROUPS",
    "FILTER",
  ];

  for (const terminator of terminators) {
    const sql = [
      "alpha DESC NULLS LAST",
      "beta USING > NULLS FIRST",
      "qualified USING OPERATOR(pg_catalog.<) NULLS LAST",
    ].join(", ") + ` ${terminator} caller_owned`;
    const { cursor, kernel } = createReadCursor(
      sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    const result = readSqlSortListPrefix(
      environment(51),
      cursor,
      harness.reader,
    );
    const terminatorRange = sourceRange(sql, terminator, 0);

    assert.equal(
      result.cursor.index,
      tokenIndexForRange(kernel, terminatorRange),
      terminator,
    );
    assert.equal(result.cursor.endIndex, cursor.endIndex, terminator);
    assert.equal(result.cursor.depth, cursor.depth, terminator);
    assert.equal(result.cursor.state, cursor.state, terminator);
    assert.equal(result.range.start, 0, terminator);
    assert.equal(result.range.end, terminatorRange.start - 1, terminator);
    assert.deepEqual(normalizedCalls(result), [
      "alpha",
      "beta",
      "qualified",
    ], terminator);
    assert.deepEqual(
      result.metadata.calls.map((call) => sql.slice(
        call.range.start,
        call.range.end,
      )),
      ["alpha", "beta", "qualified"],
      terminator,
    );
    assert.equal(harness.snapshot().calls, 3, terminator);
  }
});

test("prefix ORDER BY leaves contextual words to the expression grammar", (): void => {
  const cases: ReadonlyArray<Readonly<{
    expression: string;
    sql: string;
    terminator: string;
  }>> = [
    {
      expression: "ASC",
      sql: "ASC RANGE caller_owned",
      terminator: "RANGE",
    },
    {
      expression: "using",
      sql: "using ROWS caller_owned",
      terminator: "ROWS",
    },
    {
      expression: "using + desc",
      sql: "using + desc DESC GROUPS caller_owned",
      terminator: "GROUPS",
    },
    {
      expression: "nulls + asc",
      sql: "nulls + asc NULLS FIRST RANGE caller_owned",
      terminator: "RANGE",
    },
    {
      expression: "value AND using",
      sql: "value AND using DESC boundary caller_owned",
      terminator: "boundary",
    },
    {
      expression: "\"desc\" + \"nulls\"",
      sql: "\"desc\" + \"nulls\" ASC owner caller_owned",
      terminator: "owner",
    },
  ];

  for (const expected of cases) {
    const { cursor, kernel } = createReadCursor(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    const result = readSqlSortListPrefix(
      environment(52),
      cursor,
      harness.reader,
    );
    const terminatorRange = sourceRange(expected.sql, expected.terminator, 0);

    assert.equal(
      result.cursor.index,
      tokenIndexForRange(kernel, terminatorRange),
      expected.sql,
    );
    assert.deepEqual(
      result.metadata.calls.map((call) => expected.sql.slice(
        call.range.start,
        call.range.end,
      )),
      [expected.expression],
      expected.sql,
    );
    assert.equal(harness.snapshot().calls, 1, expected.sql);
  }
});

test("prefix ORDER BY preserves nested quoted expressions, metadata, bounds, and depth", (): void => {
  const expression = [
    "\"schema\".\"desc\"",
    "+ outer_fn(inner + 1, array_value[using + 2, nested(\"nulls\")])",
  ].join(" ");
  const sortList = `${expression} DESC NULLS FIRST, beta USING > NULLS LAST`;
  const sql = `prefix ${sortList} RANGE trailing`;
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const state = createSqlReadState(kernel);
  const parent = enterSqlReadDepth(
    createSqlReadCursor(state, 1, kernel.tokens.length - 1),
    "Enter bounded prefix ORDER BY test parent",
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlSortListPrefix(
    environment(53),
    parent,
    harness.reader,
  );
  const snapshot = harness.snapshot();
  const rangeTerminator = sourceRange(sql, "RANGE", 0);

  assert.equal(result.cursor.state, parent.state);
  assert.equal(result.cursor.index, tokenIndexForRange(kernel, rangeTerminator));
  assert.equal(result.cursor.endIndex, parent.endIndex);
  assert.equal(result.cursor.depth, parent.depth);
  assert.deepEqual(result.range, {
    start: sourceRange(sql, "\"schema\"", 0).start,
    end: sourceRange(sql, "LAST", 0).end,
  });
  assert.deepEqual(
    result.metadata.calls.map((call) => sql.slice(
      call.range.start,
      call.range.end,
    )),
    [expression, "beta"],
  );
  assert.equal(result.metadata.nestedQueries.length, 2);
  assert.equal(result.metadata.typeConstructs.length, 2);
  assert.equal(Object.isFrozen(result.metadata.calls), true);
  assert.equal(Object.isFrozen(result.metadata.nestedQueries), true);
  assert.equal(Object.isFrozen(result.metadata.typeConstructs), true);
  assert.equal(snapshot.calls, 2);
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.depth),
    [parent.depth + 1, parent.depth + 1],
  );
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.endIndex),
    [parent.endIndex, parent.endIndex],
  );
  const firstInvocation = snapshot.invocations[0];
  const secondInvocation = snapshot.invocations[1];
  assert.notEqual(firstInvocation, undefined);
  assert.notEqual(secondInvocation, undefined);
  assert.equal(
    firstInvocation.startWorkUnits < firstInvocation.resultWorkUnits,
    true,
  );
  assert.equal(
    firstInvocation.resultWorkUnits < secondInvocation.startWorkUnits,
    true,
  );
  assert.equal(
    secondInvocation.startWorkUnits < secondInvocation.resultWorkUnits,
    true,
  );
  assert.equal(
    snapshot.lastReturnedWorkUnits !== null
      && result.cursor.workUnits > snapshot.lastReturnedWorkUnits,
    true,
  );
});

test("prefix ORDER BY rejects empty items and strict incomplete expressions precisely", (): void => {
  const emptyItems: ReadonlyArray<Readonly<{
    calls: number;
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      calls: 0,
      message: "ORDER BY requires at least one expression",
      range: { start: 0, end: 0 },
      sql: "",
    },
    {
      calls: 0,
      message: "ORDER BY item requires an expression before comma",
      range: { start: 0, end: 1 },
      sql: ", value",
    },
    {
      calls: 1,
      message: "ORDER BY cannot end with a comma",
      range: { start: 5, end: 6 },
      sql: "value,",
    },
    {
      calls: 1,
      message: "ORDER BY item requires an expression before comma",
      range: { start: 7, end: 8 },
      sql: "value, , other",
    },
  ];

  for (const invalid of emptyItems) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlSortListPrefix(
        environment(54),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
    assert.equal(harness.snapshot().calls, invalid.calls, invalid.sql);
  }

  const incomplete: ReadonlyArray<Readonly<{
    range: SqlSourceRange;
    sql: string;
  }>> = [
    { range: { start: 7, end: 7 }, sql: "value +" },
    { range: { start: 7, end: 8 }, sql: "value +, other" },
    { range: { start: 9, end: 9 }, sql: "value AND" },
  ];
  for (const invalid of incomplete) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlSortListPrefix(
        environment(54),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      invalid.range,
      "Deterministic sort prefix expression requires an operand",
    );
    assert.equal(harness.snapshot().calls, 1, invalid.sql);
  }
});

test("prefix ORDER BY validates direct and qualified PostgreSQL all_Op spellings", (): void => {
  const specialOperators: ReadonlyArray<string> = ["::", ":=", "..", "=>"];

  for (const operator of specialOperators) {
    const directSql = `value USING ${operator} RANGE caller_owned`;
    const direct = createReadCursor(
      directSql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const directHarness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlSortListPrefix(
        environment(55),
        direct.cursor,
        directHarness.reader,
      ),
      "unexpected_token",
      sourceRange(directSql, operator, 0),
      `ORDER BY USING requires a PostgreSQL all_Op operator; "${operator}" is reserved syntax`,
    );
    assert.equal(directHarness.snapshot().calls, 1);

    const qualifiedSql = `value USING OPERATOR(pg_catalog. ${operator}) RANGE caller_owned`;
    const qualified = createReadCursor(
      qualifiedSql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const qualifiedHarness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlSortListPrefix(
        environment(55),
        qualified.cursor,
        qualifiedHarness.reader,
      ),
      "unexpected_token",
      sourceRange(qualifiedSql, operator, 0),
      `ORDER BY USING OPERATOR requires a PostgreSQL all_Op operator; "${operator}" is reserved syntax`,
    );
    assert.equal(qualifiedHarness.snapshot().calls, 1);
  }
});

test("prefix ORDER BY rejects missing, repeated, and misordered suffixes", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    rangeText: string;
    sql: string;
  }>> = [
    {
      message: "ORDER BY NULLS requires FIRST or LAST",
      rangeText: "RANGE",
      sql: "value NULLS RANGE caller_owned",
    },
    {
      message: "ORDER BY item cannot contain more than one ASC, DESC, or USING clause",
      rangeText: "DESC",
      sql: "value ASC DESC RANGE caller_owned",
    },
    {
      message: "USING must appear before NULLS ordering in an ORDER BY item",
      rangeText: "USING",
      sql: "value NULLS FIRST USING > RANGE caller_owned",
    },
    {
      message: "ORDER BY USING requires an operator",
      rangeText: "RANGE",
      sql: "value USING RANGE caller_owned",
    },
  ];

  for (const invalid of cases) {
    const { cursor } = createReadCursor(
      invalid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const harness = createPrefixReaderHarness();
    expectParserError(
      () => readSqlSortListPrefix(
        environment(58),
        cursor,
        harness.reader,
      ),
      "unexpected_token",
      sourceRange(invalid.sql, invalid.rangeText, 0),
      invalid.message,
    );
    assert.equal(harness.snapshot().calls, 1, invalid.sql);
  }
});

test("prefix ORDER BY uses one collaborator call per item and linear transitions", (): void => {
  const count = 2_000;
  const list = Array.from(
    { length: count },
    (_unused, index) => `item_${String(index)}`,
  ).join(",");
  const sql = `${list} RANGE caller_owned`;
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlSortListPrefix(
    environment(56),
    cursor,
    harness.reader,
  );
  const snapshot = harness.snapshot();
  const collaboratorTransitions = snapshot.transitions;
  const totalTransitions = result.cursor.workUnits - cursor.workUnits;
  const sortTransitions = totalTransitions - collaboratorTransitions;

  assert.equal(snapshot.calls, count);
  assert.equal(snapshot.invocations.length, count);
  assert.equal(collaboratorTransitions, count * 4);
  assert.equal(sortTransitions, count * 5 - 1);
  assert.equal(totalTransitions, count * 9 - 1);
  assert.equal(result.metadata.calls.length, count);
  assert.equal(normalizedCalls(result)[0], "item_0");
  assert.equal(normalizedCalls(result).at(-1), `item_${String(count - 1)}`);
  assert.equal(
    result.cursor.index,
    tokenIndexForRange(kernel, sourceRange(sql, "RANGE", 0)),
  );
});

test("prefix ORDER BY work accepts the exact maximum and fails at first excess", (): void => {
  const sql = "first, second DESC NULLS LAST RANGE caller_owned";
  const ample = createReadCursor(
    sql,
    limits(sql.length, 20, 3, 200),
  );
  const ampleHarness = createPrefixReaderHarness();
  const measured = readSqlSortListPrefix(
    environment(57),
    ample.cursor,
    ampleHarness.reader,
  );
  const exactLimit = measured.cursor.workUnits;

  const exact = createReadCursor(
    sql,
    limits(sql.length, 20, 3, exactLimit),
  );
  const exactHarness = createPrefixReaderHarness();
  const exactResult = readSqlSortListPrefix(
    environment(57),
    exact.cursor,
    exactHarness.reader,
  );
  assert.equal(exactResult.cursor.workUnits, exactLimit);
  assert.equal(exactHarness.snapshot().calls, 2);

  const firstExcess = createReadCursor(
    sql,
    limits(sql.length, 20, 3, exactLimit - 1),
  );
  const firstExcessHarness = createPrefixReaderHarness();
  expectParserError(
    () => readSqlSortListPrefix(
      environment(57),
      firstExcess.cursor,
      firstExcessHarness.reader,
    ),
    "limit_complexity",
    sourceRange(sql, "RANGE", 0),
    `SQL parser Inspect ORDER BY item terminator exceeded maxWorkUnits=${String(exactLimit - 1)} at token 6`,
  );
  assert.equal(firstExcessHarness.snapshot().calls, 2);
});
