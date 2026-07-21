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
import { readSqlFunctionApplication } from "./sql-policy-read-function.js";
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
import {
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

type DeterministicExpressionRead = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadataSequence;
}>;

type CallableProbe = Readonly<{
  callable: boolean;
  cursor: SqlReadCursor;
}>;

type CursorContractCase = Readonly<{
  apply: (
    operation: string,
    entered: SqlReadCursor,
    returned: SqlReadCursor,
    foreign: SqlReadCursor,
  ) => Readonly<{
    cursor: SqlReadCursor;
    message: string;
  }>;
  name: string;
}>;

type CollaboratorContext = Readonly<{
  operation: string;
  sql: string;
  target: string;
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

const metadataForIdentifier = (
  expressionEnvironment: SqlExpressionEnvironment,
  token: SqlIdentifierToken,
  startIndex: number,
  endIndex: number,
  sql: string,
): SqlExpressionMetadataSequence => {
  const range = token.range;
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
    nameRange: range,
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
  return concatSqlExpressionMetadataSequences(
    concatSqlExpressionMetadataSequences(
      sqlCallMetadataSequence(call),
      sqlNestedQueryMetadataSequence(nestedQuery),
    ),
    sqlTypeConstructMetadataSequence(typeConstruct),
  );
};

const countMetadataConcatNodes = (
  sequence: SqlExpressionMetadataSequence,
): number => {
  const stack: Array<SqlExpressionMetadataSequence> = [sequence];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    assert.ok(current);
    if (current.kind === "concat") {
      count++;
      stack.push(current.right, current.left);
    }
  }
  return count;
};

const repeatMetadataSequence = (
  item: SqlExpressionMetadataSequence,
  count: number,
): SqlExpressionMetadataSequence => {
  let sequence = emptySqlExpressionMetadataSequence();
  for (let index = 0; index < count; index++) {
    sequence = concatSqlExpressionMetadataSequences(sequence, item);
  }
  return sequence;
};

const cursorContractCases = (): ReadonlyArray<CursorContractCase> =>
  Object.freeze([
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({
          ...returned,
          endIndex: entered.endIndex - 1,
        }),
        message: `${operation} returned cursor end ${String(entered.endIndex - 1)} must equal the entered child end ${String(entered.endIndex)}`,
      }),
      name: "narrowed end",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({
          ...returned,
          endIndex: entered.endIndex + 1,
        }),
        message: `${operation} returned cursor end ${String(entered.endIndex + 1)} must equal the entered child end ${String(entered.endIndex)}`,
      }),
      name: "widened end",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({ ...returned, depth: entered.depth - 1 }),
        message: `${operation} returned cursor nesting depth ${String(entered.depth - 1)} must equal the entered child depth ${String(entered.depth)}`,
      }),
      name: "lower depth",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({ ...returned, depth: entered.depth + 1 }),
        message: `${operation} returned cursor nesting depth ${String(entered.depth + 1)} must equal the entered child depth ${String(entered.depth)}`,
      }),
      name: "higher depth",
    }),
    Object.freeze({
      apply: (
        operation: string,
        _entered: SqlReadCursor,
        returned: SqlReadCursor,
        foreign: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({ ...returned, state: foreign.state }),
        message: `${operation} returned cursor must use the entered child SQL read state`,
      }),
      name: "foreign state",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({
          ...returned,
          index: entered.index - 1,
        }),
        message: `${operation} returned cursor index ${String(entered.index - 1)} outside the exact entered child range ${String(entered.index)}..${String(entered.endIndex)}`,
      }),
      name: "index before child",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({
          ...returned,
          index: entered.endIndex + 1,
        }),
        message: `${operation} returned cursor index ${String(entered.endIndex + 1)} outside the exact entered child range ${String(entered.index)}..${String(entered.endIndex)}`,
      }),
      name: "index after child",
    }),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => Object.freeze({
        cursor: Object.freeze({
          ...returned,
          workUnits: entered.workUnits - 1,
        }),
        message: `${operation} returned cursor workUnits=${String(entered.workUnits - 1)} would rewind entered child work from ${String(entered.workUnits)}`,
      }),
      name: "decreased work",
    }),
    ...[
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]
      .map((workUnits): CursorContractCase => Object.freeze({
        apply: (
          operation: string,
          _entered: SqlReadCursor,
          returned: SqlReadCursor,
        ) => Object.freeze({
          cursor: Object.freeze({ ...returned, workUnits }),
          message: `${operation} returned cursor workUnits must be a non-negative safe integer; received ${String(workUnits)}`,
        }),
        name: `invalid work ${String(workUnits)}`,
      })),
    Object.freeze({
      apply: (
        operation: string,
        entered: SqlReadCursor,
        returned: SqlReadCursor,
      ) => {
        const workUnits = entered.state.limits.maxWorkUnits + 1;
        return Object.freeze({
          cursor: Object.freeze({ ...returned, workUnits }),
          message: `${operation} returned cursor workUnits=${String(workUnits)} exceeds maxWorkUnits=${String(entered.state.limits.maxWorkUnits)}`,
        });
      },
      name: "work above limit",
    }),
  ]);

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

const inspectCallableApplication = (
  cursor: SqlReadCursor,
): CallableProbe => {
  let current = cursor;
  let offset = 1;
  while (true) {
    const next = inspectSqlReadToken(
      current,
      offset,
      "Inspect deterministic callable continuation",
    );
    current = next.cursor;
    if (next.token?.text === "(") {
      return Object.freeze({ callable: true, cursor: current });
    }
    if (next.token?.text !== ".") {
      return Object.freeze({ callable: false, cursor: current });
    }
    const part = inspectSqlReadToken(
      current,
      offset + 1,
      "Inspect deterministic qualified callable part",
    );
    current = part.cursor;
    if (part.token?.kind !== "identifier") {
      return Object.freeze({ callable: false, cursor: current });
    }
    offset += 2;
  }
};

const readDeterministicGroupedExpression = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): DeterministicExpressionRead => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter deterministic grouped expression",
  );
  const matched = matchingSqlReadDelimiter(
    nested,
    "Match deterministic grouped expression",
  );
  const opening = consumeSqlReadToken(
    matched.cursor,
    "Consume deterministic grouped-expression opening parenthesis",
  ).cursor;
  const body = narrowSqlReadCursor(
    opening,
    matched.closeIndex,
    "Bound deterministic grouped-expression body",
  );
  const first = inspectSqlReadToken(
    body,
    0,
    "Inspect deterministic grouped-expression body",
  );
  if (first.token === undefined) {
    return deterministicPrefixError(
      first.cursor,
      "Deterministic grouped expression cannot be empty",
    );
  }
  const expression = readDeterministicExpressionPrefix(
    expressionEnvironment,
    first.cursor,
    readExpressionPrefix,
  );
  if (expression.cursor.index !== expression.cursor.endIndex) {
    return deterministicPrefixError(
      expression.cursor,
      "Deterministic grouped expression has a trailing token",
    );
  }
  const atClosing = resumeSqlReadCursor(
    opening,
    expression.cursor,
    "Resume deterministic grouped-expression body",
  );
  const closing = consumeSqlReadToken(
    atClosing,
    "Consume deterministic grouped-expression closing parenthesis",
  ).cursor;
  return Object.freeze({
    cursor: resumeSqlReadCursor(
      cursor,
      closing,
      "Resume deterministic grouped expression",
    ),
    metadata: expression.metadata,
  });
};

const readDeterministicPrimary = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): DeterministicExpressionRead => {
  let current = cursor;
  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic function-test expression primary",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return deterministicPrefixError(
        current,
        "Deterministic expression requires an operand",
      );
    }
    if (isUnaryOperator(inspected.token)) {
      current = consumeSqlReadToken(
        current,
        "Consume deterministic function-test unary operator",
      ).cursor;
      continue;
    }
    if (inspected.token.text === "(") {
      return readDeterministicGroupedExpression(
        expressionEnvironment,
        current,
        readExpressionPrefix,
      );
    }
    if (!isExpressionAtom(inspected.token)) {
      return deterministicPrefixError(
        current,
        "Deterministic expression requires an operand",
      );
    }
    if (inspected.token.kind === "identifier") {
      const callable = inspectCallableApplication(current);
      current = callable.cursor;
      if (callable.callable) {
        const result = readSqlFunctionApplication(
          expressionEnvironment,
          current,
          readExpressionPrefix,
        );
        return Object.freeze({
          cursor: result.cursor,
          metadata: result.metadata,
        });
      }
    }
    return Object.freeze({
      cursor: consumeSqlReadToken(
        current,
        "Consume deterministic function-test expression atom",
      ).cursor,
      metadata: emptyMetadata(),
    });
  }
};

const readDeterministicExpressionPrefix = (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlExpressionResult => {
  const startIndex = cursor.index;
  let metadata = emptySqlExpressionMetadataSequence();
  let primary = readDeterministicPrimary(
    expressionEnvironment,
    cursor,
    readExpressionPrefix,
  );
  metadata = concatSqlExpressionMetadataSequences(
    metadata,
    primary.metadata,
  );
  let current = primary.cursor;

  while (true) {
    const inspected = inspectSqlReadToken(
      current,
      0,
      "Inspect deterministic function-test expression continuation",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      break;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (
      inspected.token.kind !== "operator"
      && !isBooleanOperator(word)
    ) {
      break;
    }
    if (inspected.token.text === "=>" || inspected.token.text === ":=") {
      break;
    }
    current = consumeSqlReadToken(
      current,
      "Consume deterministic function-test expression operator",
    ).cursor;
    primary = readDeterministicPrimary(
      expressionEnvironment,
      current,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      primary.metadata,
    );
    current = primary.cursor;
  }

  return Object.freeze({
    cursor: current,
    metadata,
    range: sqlReadRangeForSpan(cursor.state, startIndex, current.index),
  });
};

const createPrefixReaderHarness = (): PrefixReaderHarness => {
  let calls = 0;
  let lastReturnedWorkUnits: number | null = null;
  let transitions = 0;
  const invocations: Array<PrefixReaderInvocation> = [];
  let reader: SqlExpressionPrefixReader;
  reader = (
    expressionEnvironment: SqlExpressionEnvironment,
    cursor: SqlReadCursor,
  ): SqlExpressionResult => {
    calls++;
    const result = readDeterministicExpressionPrefix(
      expressionEnvironment,
      cursor,
      reader,
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

const readFunction = (
  sql: string,
  queryId: number,
  parserLimits: SqlParserLimits,
): Readonly<{
  harness: PrefixReaderHarness;
  kernel: SqlParserKernel;
  result: SqlExpressionResult;
}> => {
  const { cursor, kernel } = createReadCursor(sql, parserLimits);
  const harness = createPrefixReaderHarness();
  const result = readSqlFunctionApplication(
    environment(queryId),
    cursor,
    harness.reader,
  );
  return Object.freeze({ harness, kernel, result });
};

const createIdentifierMetadataReader = (
  sql: string,
): SqlExpressionPrefixReader => (
  expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect metadata-bearing function-test expression",
  );
  if (inspected.token?.kind !== "identifier") {
    return deterministicPrefixError(
      inspected.cursor,
      "Metadata-bearing function-test expression requires an identifier",
    );
  }
  const consumed = consumeSqlReadToken(
    inspected.cursor,
    "Consume metadata-bearing function-test expression",
  ).cursor;
  return Object.freeze({
    cursor: consumed,
    metadata: metadataForIdentifier(
      expressionEnvironment,
      inspected.token,
      cursor.index,
      consumed.index,
      sql,
    ),
    range: sqlReadRangeForSpan(
      cursor.state,
      cursor.index,
      consumed.index,
    ),
  });
};

const createFixedMetadataReader = (
  metadata: SqlExpressionMetadataSequence,
): SqlExpressionPrefixReader => (
  _expressionEnvironment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
): SqlExpressionResult => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect fixed-metadata function-test expression",
  );
  if (inspected.token === undefined) {
    return deterministicPrefixError(
      inspected.cursor,
      "Fixed-metadata function-test expression requires a token",
    );
  }
  const consumed = consumeSqlReadToken(
    inspected.cursor,
    "Consume fixed-metadata function-test expression",
  ).cursor;
  return Object.freeze({
    cursor: consumed,
    metadata,
    range: sqlReadRangeForSpan(
      cursor.state,
      cursor.index,
      consumed.index,
    ),
  });
};

const normalizedCalls = (
  result: SqlExpressionResult,
): ReadonlyArray<string> => materializeSqlExpressionMetadataSequence(
  result.metadata,
).calls.map((call) =>
  call.path.map((part) => part.untruncatedNormalized).join(".")
);

const materializedMetadata = (
  result: SqlExpressionResult,
): SqlExpressionMetadata => materializeSqlExpressionMetadataSequence(
  result.metadata,
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

const expectDynamicParserError = (
  action: () => unknown,
  code: SqlPolicyParserErrorCode,
  range: SqlSourceRange,
  message: () => string,
): void => assert.throws(action, (error: unknown): boolean => {
  assert.ok(error instanceof SqlPolicyParserError);
  assert.equal(error.code, code);
  assert.deepEqual(error.range, range);
  assert.equal(error.message, message());
  return true;
});

test("function applications accept every PostgreSQL argument branch", (): void => {
  const cases: ReadonlyArray<Readonly<{
    calls: number;
    sql: string;
  }>> = [
    { calls: 0, sql: "f()" },
    { calls: 0, sql: "f(*)" },
    { calls: 2, sql: "f(1, value + 2)" },
    { calls: 4, sql: "f(ALL 1, 2 ORDER BY first DESC, second)" },
    { calls: 3, sql: "f(DISTINCT 1, 2 ORDER BY sorted)" },
    { calls: 1, sql: "f(VARIADIC values)" },
    { calls: 2, sql: "f(1, VARIADIC values)" },
    { calls: 2, sql: "f(VARIADIC values ORDER BY sorted)" },
    { calls: 2, sql: "f(a => 1, b := 2)" },
    { calls: 3, sql: "f(1, b => 2, c := 3)" },
    { calls: 1, sql: "f(VARIADIC arr => values)" },
  ];

  for (const expected of cases) {
    const { harness, result } = readFunction(
      expected.sql,
      81,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    assert.equal(result.cursor.index, result.cursor.endIndex, expected.sql);
    assert.equal(result.cursor.depth, 0, expected.sql);
    assert.equal(harness.snapshot().calls, expected.calls, expected.sql);
    assert.deepEqual(normalizedCalls(result), ["f"], expected.sql);
    assert.deepEqual(result.range, { start: 0, end: expected.sql.length });
  }
});

test("function applications accept every ordered decorator combination", (): void => {
  const cases: ReadonlyArray<Readonly<{
    calls: number;
    sql: string;
  }>> = [
    { calls: 1, sql: "f(1)" },
    { calls: 2, sql: "f(1) WITHIN GROUP (ORDER BY sorted)" },
    { calls: 2, sql: "f(1) FILTER (WHERE kept)" },
    { calls: 1, sql: "f(1) OVER named_window" },
    { calls: 3, sql: "f(1) WITHIN GROUP (ORDER BY sorted) FILTER (WHERE kept)" },
    { calls: 2, sql: "f(1) WITHIN GROUP (ORDER BY sorted) OVER named_window" },
    { calls: 2, sql: "f(1) FILTER (WHERE kept) OVER named_window" },
    {
      calls: 3,
      sql: "f(1) WITHIN GROUP (ORDER BY sorted) FILTER (WHERE kept) OVER named_window",
    },
    { calls: 1, sql: "f(1) OVER ()" },
  ];

  for (const expected of cases) {
    const { harness, result } = readFunction(
      expected.sql,
      82,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    assert.equal(result.cursor.index, result.cursor.endIndex, expected.sql);
    assert.equal(harness.snapshot().calls, expected.calls, expected.sql);
    assert.deepEqual(normalizedCalls(result), ["f"], expected.sql);
    assert.deepEqual(result.range, { start: 0, end: expected.sql.length });
  }
});

test("OVER delegates its exact merged window specification", (): void => {
  const sql = [
    "f(1) OVER (base_window",
    "PARTITION BY partition_one, partition_two",
    "ORDER BY sorted DESC",
    "ROWS offset_value PRECEDING)",
  ].join(" ");
  const { harness, result } = readFunction(
    sql,
    83,
    DEFAULT_SQL_PARSER_LIMITS,
  );

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(harness.snapshot().calls, 5);
  assert.deepEqual(normalizedCalls(result), ["f"]);
});

test("qualified and contextual callable names use PostgreSQL classifications", (): void => {
  const accepted: ReadonlyArray<Readonly<{
    name: string;
    path: ReadonlyArray<string>;
  }>> = [
    { name: "rows()", path: ["rows"] },
    { name: "over()", path: ["over"] },
    { name: "by()", path: ["by"] },
    { name: "probe.into()", path: ["probe", "into"] },
    { name: "probe.union()", path: ["probe", "union"] },
    { name: "probe.select()", path: ["probe", "select"] },
    { name: "\"SELECT\"()", path: ["SELECT"] },
  ];

  for (const expected of accepted) {
    const sql = `${expected.name} trailing`;
    const { kernel, result } = readFunction(
      sql,
      84,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const call = materializedMetadata(result).calls[0];
    assert.ok(call);
    assert.deepEqual(
      call.path.map((part) => part.normalized),
      expected.path,
      expected.name,
    );
    assert.equal(
      result.cursor.index,
      tokenIndexForRange(kernel, sourceRange(sql, "trailing", 0)),
      expected.name,
    );
    assert.equal(result.cursor.endIndex, kernel.tokens.length, expected.name);
    assert.equal(sql.slice(call.range.start, call.range.end), expected.name);
  }

  const rejected: ReadonlyArray<string> = [
    "between()",
    "array()",
    "select()",
    "select.f()",
  ];
  for (const sql of rejected) {
    assert.throws(
      () => readFunction(sql, 84, DEFAULT_SQL_PARSER_LIMITS),
      SqlPolicyParserError,
      sql,
    );
  }
});

test("call and argument ranges remain lossless across comments and decorators", (): void => {
  const sql = [
    "probe /* qualifier */ . select /* open */ ( /* arg */ first )",
    "FILTER /* filter */ ( WHERE second )",
    "OVER /* over */ named_window",
    "trailing",
  ].join(" ");
  const { kernel, result } = readFunction(
    sql,
    85,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const materialized = materializedMetadata(result);
  const call = materialized.calls[0];
  assert.ok(call);

  assert.deepEqual(normalizedCalls(result), ["probe.select"]);
  assert.deepEqual(call.range, {
    start: 0,
    end: sql.indexOf(" FILTER"),
  });
  assert.equal(
    sql.slice(call.argumentsRange.start, call.argumentsRange.end),
    " /* arg */ first ",
  );
  assert.deepEqual(result.range, {
    start: 0,
    end: sql.indexOf(" trailing"),
  });
  assert.equal(
    result.cursor.index,
    tokenIndexForRange(kernel, sourceRange(sql, "trailing", 0)),
  );
  assert.equal(call.context, "root");
  assert.equal(call.queryId, 85);
  assert.equal(call.syntaxContext, "expression");
  assert.equal(Object.isFrozen(call), true);
  assert.equal(Object.isFrozen(call.path), true);
  assert.equal(Object.isFrozen(materialized.calls), true);
});

test("generic reader leaves unqualified common-expression constructs to their own layer", (): void => {
  const commonExpressionNames: ReadonlyArray<string> = Object.freeze([
    "cast",
    "coalesce",
    "extract",
    "greatest",
    "grouping",
    "least",
    "nullif",
    "overlay",
    "position",
    "substring",
    "treat",
  ]);

  for (const name of commonExpressionNames) {
    assert.throws(
      () => readFunction(`${name}()`, 85, DEFAULT_SQL_PARSER_LIMITS),
      SqlPolicyParserError,
      name,
    );
    assert.deepEqual(
      normalizedCalls(
        readFunction(
          `schema.${name}()`,
          85,
          DEFAULT_SQL_PARSER_LIMITS,
        ).result,
      ),
      [`schema.${name}`],
      name,
    );
  }
});

test("nested function metadata is ordered by source without decorator false calls", (): void => {
  const sql = [
    "outer(over(), schema.by(1))",
    "WITHIN GROUP (ORDER BY by())",
    "FILTER (WHERE over())",
    "OVER (PARTITION BY rows() ORDER BY schema.for())",
  ].join(" ");
  const { result } = readFunction(
    sql,
    86,
    DEFAULT_SQL_PARSER_LIMITS,
  );

  assert.deepEqual(normalizedCalls(result), [
    "outer",
    "over",
    "schema.by",
    "by",
    "over",
    "rows",
    "schema.for",
  ]);
  for (const falseCall of [
    "filter",
    "group",
    "order",
    "partition",
    "where",
    "within",
  ]) {
    assert.equal(normalizedCalls(result).includes(falseCall), false);
  }
  for (const call of materializedMetadata(result).calls) {
    assert.equal(call.context, "root");
    assert.equal(call.queryId, 86);
    assert.equal(call.syntaxContext, "expression");
  }
});

test("mixed argument and decorator metadata stays in source order and freezes once materialized", (): void => {
  const sql = [
    "f(argument)",
    "WITHIN GROUP (ORDER BY within_sort)",
    "FILTER (WHERE filter_value)",
    "OVER (PARTITION BY partition_value",
    "ORDER BY window_sort ROWS frame_value PRECEDING)",
  ].join(" ");
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlFunctionApplication(
    environment(96),
    cursor,
    createIdentifierMetadataReader(sql),
  );
  const metadata = materializedMetadata(result);
  const expressionNames = [
    "argument",
    "within_sort",
    "filter_value",
    "partition_value",
    "window_sort",
    "frame_value",
  ];

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.deepEqual(
    metadata.calls.map((call) => call.path[0]?.untruncatedNormalized),
    ["f", ...expressionNames],
  );
  assert.deepEqual(
    metadata.nestedQueries.map((node) => sql.slice(
      node.range.start,
      node.range.end,
    )),
    expressionNames,
  );
  assert.deepEqual(
    metadata.typeConstructs.map((node) => sql.slice(
      node.range.start,
      node.range.end,
    )),
    expressionNames,
  );
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.calls), true);
  assert.equal(Object.isFrozen(metadata.nestedQueries), true);
  assert.equal(Object.isFrozen(metadata.typeConstructs), true);
});

test("canonical empty collaborator metadata does not create persistent concat nodes", (): void => {
  const sql = "f(value) OVER named_window";
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const empty = emptySqlExpressionMetadataSequence();
  const result = readSqlFunctionApplication(
    environment(97),
    cursor,
    createFixedMetadataReader(empty),
  );

  assert.equal(empty, emptySqlExpressionMetadataSequence());
  assert.equal(result.metadata.kind, "call");
  assert.equal(result.metadata.callCount, 1);
  assert.equal(result.metadata.nestedQueryCount, 0);
  assert.equal(result.metadata.typeConstructCount, 0);
  assert.equal(countMetadataConcatNodes(result.metadata), 0);
  assert.deepEqual(normalizedCalls(result), ["f"]);
});

test("deep persistent collaborator metadata keeps identity and cursor work independent of metadata size", (): void => {
  const sql = "f(value)";
  const { cursor, kernel } = createReadCursor(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const token = kernel.tokens[2];
  assert.equal(token?.kind, "identifier");
  if (token?.kind !== "identifier") {
    throw new Error("Deep metadata test lost its value identifier token");
  }
  const item = metadataForIdentifier(
    environment(98),
    token,
    2,
    3,
    sql,
  );
  const itemCount = 25_000;
  const deep = repeatMetadataSequence(item, itemCount);
  const emptyResult = readSqlFunctionApplication(
    environment(98),
    cursor,
    createFixedMetadataReader(emptySqlExpressionMetadataSequence()),
  );
  const result = readSqlFunctionApplication(
    environment(98),
    cursor,
    createFixedMetadataReader(deep),
  );

  assert.equal(result.cursor.workUnits, emptyResult.cursor.workUnits);
  assert.equal(result.metadata.kind, "concat");
  if (result.metadata.kind !== "concat") {
    throw new Error("Deep metadata test expected the outer call concat");
  }
  assert.equal(result.metadata.right, deep);
  const materialized = materializedMetadata(result);
  assert.equal(materialized.calls.length, itemCount + 1);
  assert.equal(materialized.nestedQueries.length, itemCount);
  assert.equal(materialized.typeConstructs.length, itemCount);
  assert.equal(Object.isFrozen(materialized.calls), true);
});

test("persistent metadata concat structure grows linearly with composed items", (): void => {
  const itemCount = 2_000;
  const sql = `f(${Array.from(
    { length: itemCount },
    (_unused, index) => `item_${String(index)}`,
  ).join(",")})`;
  const { cursor } = createReadCursor(sql, DEFAULT_SQL_PARSER_LIMITS);
  const result = readSqlFunctionApplication(
    environment(99),
    cursor,
    createIdentifierMetadataReader(sql),
  );

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(result.metadata.callCount, itemCount + 1);
  assert.equal(result.metadata.nestedQueryCount, itemCount);
  assert.equal(result.metadata.typeConstructCount, itemCount);
  assert.equal(countMetadataConcatNodes(result.metadata), itemCount * 3);
});

test("function arguments reject malformed and PostgreSQL-illegal combinations", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    occurrence: number;
    rangeText: string;
    sql: string;
  }>> = [
    {
      message: "PostgreSQL VARIADIC argument must be the final function argument",
      occurrence: 0,
      rangeText: ",",
      sql: "f(VARIADIC 1, 2)",
    },
    {
      message: "ALL function arguments cannot use VARIADIC",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(ALL VARIADIC 1)",
    },
    {
      message: "DISTINCT function arguments cannot use VARIADIC",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(DISTINCT VARIADIC 1)",
    },
    {
      message: "PostgreSQL VARIADIC requires a function argument expression",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(VARIADIC)",
    },
    {
      message: "PostgreSQL VARIADIC requires a function argument expression",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(1, VARIADIC)",
    },
    {
      message: "PostgreSQL VARIADIC argument must be the final function argument",
      occurrence: 1,
      rangeText: ",",
      sql: "f(1, VARIADIC values, 2)",
    },
    {
      message: "ALL function arguments cannot use VARIADIC",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(ALL 1, VARIADIC values)",
    },
    {
      message: "DISTINCT function arguments cannot use VARIADIC",
      occurrence: 0,
      rangeText: "VARIADIC",
      sql: "f(DISTINCT 1, VARIADIC values)",
    },
    {
      message: "PostgreSQL function argument requires an expression before comma",
      occurrence: 1,
      rangeText: ",",
      sql: "f(1,, 2)",
    },
    {
      message: "PostgreSQL function argument list cannot end with a comma",
      occurrence: 0,
      rangeText: ",",
      sql: "f(1,)",
    },
    {
      message: "Expected a comma between PostgreSQL function arguments",
      occurrence: 0,
      rangeText: "2",
      sql: "f(1 2)",
    },
    {
      message: "PostgreSQL positional argument cannot follow a named argument",
      occurrence: 0,
      rangeText: "2",
      sql: "f(a => 1, 2)",
    },
    {
      message: "PostgreSQL named argument requires a param_name from the type_function_name token class",
      occurrence: 0,
      rangeText: "between",
      sql: "f(between => 1)",
    },
    {
      message: "PostgreSQL function argument name \"a\" is used more than once",
      occurrence: 1,
      rangeText: "a",
      sql: "f(a => 1, a := 2)",
    },
    {
      message: "ALL requires at least one PostgreSQL function argument",
      occurrence: 0,
      rangeText: "ALL",
      sql: "f(ALL)",
    },
    {
      message: "DISTINCT requires at least one PostgreSQL function argument",
      occurrence: 0,
      rangeText: "DISTINCT",
      sql: "f(DISTINCT)",
    },
    {
      message: "ALL function arguments cannot use the star branch",
      occurrence: 0,
      rangeText: "*",
      sql: "f(ALL *)",
    },
    {
      message: "DISTINCT function arguments cannot use the star branch",
      occurrence: 0,
      rangeText: "*",
      sql: "f(DISTINCT *)",
    },
    {
      message: "PostgreSQL star function argument must appear alone",
      occurrence: 0,
      rangeText: ",",
      sql: "f(*, 1)",
    },
    {
      message: "PostgreSQL star function argument must appear alone",
      occurrence: 0,
      rangeText: "ORDER",
      sql: "f(* ORDER BY sorted)",
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => readFunction(invalid.sql, 87, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      sourceRange(invalid.sql, invalid.rangeText, invalid.occurrence),
      invalid.message,
    );
  }
});

test("WITHIN GROUP rejects incompatible application argument branches", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    sql: string;
  }>> = [
    {
      message: "Cannot use multiple ORDER BY clauses with WITHIN GROUP",
      sql: "f(1 ORDER BY sorted) WITHIN GROUP (ORDER BY grouped)",
    },
    {
      message: "Cannot use DISTINCT with WITHIN GROUP",
      sql: "f(DISTINCT 1) WITHIN GROUP (ORDER BY grouped)",
    },
    {
      message: "Cannot use VARIADIC with WITHIN GROUP",
      sql: "f(VARIADIC values) WITHIN GROUP (ORDER BY grouped)",
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => readFunction(invalid.sql, 88, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      sourceRange(invalid.sql, "WITHIN", 0),
      invalid.message,
    );
  }

  const valid = readFunction(
    "f(ALL 1) WITHIN GROUP (ORDER BY grouped)",
    88,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.equal(valid.result.cursor.index, valid.result.cursor.endIndex);
});

test("aggregate and WITHIN GROUP ordering reject empty and malformed sort lists", (): void => {
  const boundaryCases: ReadonlyArray<Readonly<{
    message: string;
    sql: string;
  }>> = Object.freeze([
    Object.freeze({
      message: "ORDER BY requires at least one expression",
      sql: "f(1 ORDER BY)",
    }),
    Object.freeze({
      message: "ORDER BY requires at least one expression",
      sql: "f() WITHIN GROUP (ORDER BY)",
    }),
  ]);
  for (const invalid of boundaryCases) {
    expectParserError(
      () => readFunction(invalid.sql, 88, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      { start: invalid.sql.length - 1, end: invalid.sql.length - 1 },
      invalid.message,
    );
  }

  const commaCases: ReadonlyArray<string> = Object.freeze([
    "f(1 ORDER BY sorted,)",
    "f() WITHIN GROUP (ORDER BY sorted,)",
  ]);
  for (const sql of commaCases) {
    expectParserError(
      () => readFunction(sql, 88, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      sourceRange(sql, ",", 0),
      "ORDER BY cannot end with a comma",
    );
  }
});

test("function decorators reject missing keywords, parentheses, and exact-body leftovers", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    range: SqlSourceRange;
    sql: string;
  }>> = [
    {
      message: "WITHIN requires GROUP in a PostgreSQL function decorator",
      range: { start: 10, end: 10 },
      sql: "f() WITHIN",
    },
    {
      message: "WITHIN GROUP decorator requires an opening parenthesis",
      range: { start: 16, end: 16 },
      sql: "f() WITHIN GROUP",
    },
    {
      message: "WITHIN GROUP requires ORDER BY",
      range: { start: 18, end: 18 },
      sql: "f() WITHIN GROUP ()",
    },
    {
      message: "WITHIN GROUP ORDER requires BY",
      range: { start: 23, end: 23 },
      sql: "f() WITHIN GROUP (ORDER)",
    },
    {
      message: "WITHIN GROUP decorator requires an opening parenthesis",
      range: { start: 17, end: 23 },
      sql: "f() WITHIN GROUP sorted",
    },
    {
      message: "FILTER decorator requires an opening parenthesis",
      range: { start: 10, end: 10 },
      sql: "f() FILTER",
    },
    {
      message: "FILTER requires WHERE",
      range: { start: 12, end: 12 },
      sql: "f() FILTER ()",
    },
    {
      message: "FILTER WHERE requires an expression",
      range: { start: 17, end: 17 },
      sql: "f() FILTER (WHERE)",
    },
    {
      message: "Unexpected token after PostgreSQL FILTER expression",
      range: { start: 19, end: 20 },
      sql: "f() FILTER (WHERE x, y)",
    },
    {
      message: "OVER requires a PostgreSQL ColId window name or parenthesized window specification",
      range: { start: 8, end: 8 },
      sql: "f() OVER",
    },
    {
      message: "OVER requires a PostgreSQL ColId window name or parenthesized window specification",
      range: { start: 9, end: 15 },
      sql: "f() OVER SELECT",
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => readFunction(invalid.sql, 89, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      invalid.range,
      invalid.message,
    );
  }
});

test("function decorators reject duplicates and wrong order", (): void => {
  const cases: ReadonlyArray<Readonly<{
    message: string;
    occurrence: number;
    rangeText: string;
    sql: string;
  }>> = [
    {
      message: "PostgreSQL function application cannot contain more than one WITHIN GROUP decorator",
      occurrence: 1,
      rangeText: "WITHIN",
      sql: "f() WITHIN GROUP (ORDER BY a) WITHIN GROUP (ORDER BY b)",
    },
    {
      message: "PostgreSQL function application cannot contain more than one FILTER decorator",
      occurrence: 1,
      rangeText: "FILTER",
      sql: "f() FILTER (WHERE a) FILTER (WHERE b)",
    },
    {
      message: "PostgreSQL function application cannot contain more than one OVER decorator",
      occurrence: 1,
      rangeText: "OVER",
      sql: "f() OVER () OVER ()",
    },
    {
      message: "WITHIN GROUP must appear before FILTER and OVER",
      occurrence: 0,
      rangeText: "WITHIN",
      sql: "f() FILTER (WHERE a) WITHIN GROUP (ORDER BY b)",
    },
    {
      message: "FILTER must appear before OVER",
      occurrence: 0,
      rangeText: "FILTER",
      sql: "f() OVER () FILTER (WHERE a)",
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => readFunction(invalid.sql, 90, DEFAULT_SQL_PARSER_LIMITS),
      "unexpected_token",
      sourceRange(invalid.sql, invalid.rangeText, invalid.occurrence),
      invalid.message,
    );
  }
});

test("bounded parents preserve cursor bounds, depth, ranges, and cumulative work", (): void => {
  const sql = [
    "prefix",
    "schema.call( first, second )",
    "FILTER (WHERE kept)",
    "OVER (PARTITION BY partitioned ORDER BY sorted)",
    "trailing",
  ].join(" ");
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const state = createSqlReadState(kernel);
  const parent = enterSqlReadDepth(
    createSqlReadCursor(state, 1, kernel.tokens.length - 1),
    "Enter bounded function-reader test parent",
  );
  const harness = createPrefixReaderHarness();
  const result = readSqlFunctionApplication(
    environment(91),
    parent,
    harness.reader,
  );
  const snapshot = harness.snapshot();
  const trailingIndex = tokenIndexForRange(
    kernel,
    sourceRange(sql, "trailing", 0),
  );

  assert.equal(result.cursor.state, parent.state);
  assert.equal(result.cursor.index, trailingIndex);
  assert.equal(result.cursor.endIndex, parent.endIndex);
  assert.equal(result.cursor.depth, parent.depth);
  assert.equal(result.cursor.workUnits > parent.workUnits, true);
  assert.deepEqual(result.range, {
    start: sourceRange(sql, "schema", 0).start,
    end: sourceRange(sql, ")", 2).end,
  });
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.depth),
    [
      parent.depth + 2,
      parent.depth + 2,
      parent.depth + 2,
      parent.depth + 3,
      parent.depth + 3,
    ],
  );
  assert.deepEqual(
    snapshot.invocations.slice(0, 2).map((invocation) => invocation.endIndex),
    [
      tokenIndexForRange(kernel, sourceRange(sql, ")", 0)),
      tokenIndexForRange(kernel, sourceRange(sql, ")", 0)),
    ],
  );
  for (const [index, invocation] of snapshot.invocations.entries()) {
    assert.equal(invocation.resultIndex > invocation.startIndex, true);
    assert.equal(invocation.resultWorkUnits > invocation.startWorkUnits, true);
    if (index > 0) {
      const previous = snapshot.invocations[index - 1];
      assert.ok(previous);
      assert.equal(previous.resultWorkUnits < invocation.startWorkUnits, true);
    }
  }
  assert.equal(
    snapshot.lastReturnedWorkUnits !== null
      && result.cursor.workUnits > snapshot.lastReturnedWorkUnits,
    true,
  );
});

test("every argument, sort item, filter, and window expression is delegated once", (): void => {
  const sql = [
    "f(a, b, c ORDER BY aggregate_one, aggregate_two)",
    "FILTER (WHERE kept)",
    "OVER (PARTITION BY partition_one, partition_two",
    "ORDER BY window_one, window_two",
    "ROWS offset_value PRECEDING)",
  ].join(" ");
  const { harness, kernel, result } = readFunction(
    sql,
    92,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const expectedStarts = [
    "a",
    "b",
    "c",
    "aggregate_one",
    "aggregate_two",
    "kept",
    "partition_one",
    "partition_two",
    "window_one",
    "window_two",
    "offset_value",
  ];
  const snapshot = harness.snapshot();

  assert.equal(snapshot.calls, expectedStarts.length);
  assert.deepEqual(
    snapshot.invocations.map((invocation) => invocation.startIndex),
    expectedStarts.map((text) =>
      tokenIndexForRange(kernel, sourceRange(sql, text, 0))
    ),
  );
  assert.equal(result.cursor.index, result.cursor.endIndex);
});

test("empty expression collaborator results fail as cursor invariants", (): void => {
  const sql = "f(value)";
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
    () => readSqlFunctionApplication(environment(93), cursor, emptyReader),
    "internal_invariant",
    sourceRange(sql, "value", 0),
    "PostgreSQL function argument expression prefix reader returned an empty expression",
  );
});

test("all function collaborator contexts reject altered exact entered cursors", (): void => {
  const contexts: ReadonlyArray<CollaboratorContext> = Object.freeze([
    Object.freeze({
      operation: "Resume PostgreSQL function argument expression prefix",
      sql: "f(argument)",
      target: "argument",
    }),
    Object.freeze({
      operation: "Resume ORDER BY expression prefix",
      sql: "f(argument ORDER BY aggregate_sort)",
      target: "aggregate_sort",
    }),
    Object.freeze({
      operation: "Resume ORDER BY expression prefix",
      sql: "f() WITHIN GROUP (ORDER BY within_sort)",
      target: "within_sort",
    }),
    Object.freeze({
      operation: "Resume PostgreSQL FILTER expression prefix",
      sql: "f() FILTER (WHERE filter_value)",
      target: "filter_value",
    }),
    Object.freeze({
      operation: "Resume PARTITION BY expression prefix",
      sql: "f() OVER (PARTITION BY partition_value)",
      target: "partition_value",
    }),
    Object.freeze({
      operation: "Resume ORDER BY expression prefix",
      sql: "f() OVER (ORDER BY window_sort)",
      target: "window_sort",
    }),
    Object.freeze({
      operation: "Resume window frame offset expression",
      sql: "f() OVER (ROWS frame_value PRECEDING)",
      target: "frame_value",
    }),
  ]);
  const cases = cursorContractCases();
  const foreign = createReadCursor(
    "foreign",
    DEFAULT_SQL_PARSER_LIMITS,
  ).cursor;

  for (const context of contexts) {
    for (const current of cases) {
      const { cursor } = createReadCursor(
        context.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      );
      let expectedMessage: string | null = null;
      let reader: SqlExpressionPrefixReader;
      reader = (
        expressionEnvironment: SqlExpressionEnvironment,
        child: SqlReadCursor,
      ): SqlExpressionResult => {
        const inspected = inspectSqlReadToken(
          child,
          0,
          "Inspect exact-cursor function-test target",
        );
        const result = readDeterministicExpressionPrefix(
          expressionEnvironment,
          inspected.cursor,
          reader,
        );
        if (inspected.token?.text !== context.target) {
          return result;
        }
        const altered = current.apply(
          context.operation,
          child,
          result.cursor,
          foreign,
        );
        expectedMessage = altered.message;
        return Object.freeze({ ...result, cursor: altered.cursor });
      };
      expectDynamicParserError(
        () => readSqlFunctionApplication(
          environment(100),
          cursor,
          reader,
        ),
        "internal_invariant",
        sourceRange(context.sql, context.target, 0),
        (): string => {
          assert.notEqual(
            expectedMessage,
            null,
            `${context.target} ${current.name} was not reached`,
          );
          if (expectedMessage === null) {
            throw new Error(
              `${context.target} ${current.name} was not reached`,
            );
          }
          return expectedMessage;
        },
      );
    }
  }
});

test("zero-progress collaborators retain each owning grammar error", (): void => {
  const contexts: ReadonlyArray<Readonly<{
    message: string;
    sql: string;
    target: string;
  }>> = Object.freeze([
    Object.freeze({
      message: "PostgreSQL function argument expression prefix reader returned an empty expression",
      sql: "f(argument)",
      target: "argument",
    }),
    Object.freeze({
      message: "ORDER BY expression prefix reader returned an empty expression",
      sql: "f(argument ORDER BY aggregate_sort)",
      target: "aggregate_sort",
    }),
    Object.freeze({
      message: "ORDER BY expression prefix reader returned an empty expression",
      sql: "f() WITHIN GROUP (ORDER BY within_sort)",
      target: "within_sort",
    }),
    Object.freeze({
      message: "PostgreSQL FILTER expression prefix reader returned an empty expression",
      sql: "f() FILTER (WHERE filter_value)",
      target: "filter_value",
    }),
    Object.freeze({
      message: "PARTITION BY expression prefix reader returned an empty expression",
      sql: "f() OVER (PARTITION BY partition_value)",
      target: "partition_value",
    }),
    Object.freeze({
      message: "ORDER BY expression prefix reader returned an empty expression",
      sql: "f() OVER (ORDER BY window_sort)",
      target: "window_sort",
    }),
    Object.freeze({
      message: "Window frame offset prefix reader returned an empty expression",
      sql: "f() OVER (ROWS frame_value PRECEDING)",
      target: "frame_value",
    }),
  ]);

  for (const context of contexts) {
    const { cursor } = createReadCursor(
      context.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    let reader: SqlExpressionPrefixReader;
    reader = (
      expressionEnvironment: SqlExpressionEnvironment,
      child: SqlReadCursor,
    ): SqlExpressionResult => {
      const inspected = inspectSqlReadToken(
        child,
        0,
        "Inspect zero-progress function-test target",
      );
      if (inspected.token?.text === context.target) {
        return Object.freeze({
          cursor: inspected.cursor,
          metadata: emptySqlExpressionMetadataSequence(),
          range: sqlReadRangeForSpan(
            child.state,
            child.index,
            child.index,
          ),
        });
      }
      return readDeterministicExpressionPrefix(
        expressionEnvironment,
        inspected.cursor,
        reader,
      );
    };
    expectParserError(
      () => readSqlFunctionApplication(
        environment(101),
        cursor,
        reader,
      ),
      "internal_invariant",
      sourceRange(context.sql, context.target, 0),
      context.message,
    );
  }
});

test("nested valid function applications remain within bounded reader depth", (): void => {
  const functionCount = 100;
  const sql = `${"f(".repeat(functionCount)}value${")".repeat(functionCount)}`;
  const result = readFunction(
    sql,
    102,
    limits(sql.length, functionCount * 3 + 1, 256, functionCount * 100),
  ).result;

  assert.equal(result.cursor.index, result.cursor.endIndex);
  assert.equal(result.cursor.depth, 0);
  assert.equal(materializedMetadata(result).calls.length, functionCount);
});

test("large flat argument and aggregate sort lists retain linear monotone work", (): void => {
  const argumentCount = 1_500;
  const sortCount = 1_500;
  const argumentsSql = Array.from(
    { length: argumentCount },
    (_unused, index) => `argument_${String(index)}`,
  ).join(",");
  const sortSql = Array.from(
    { length: sortCount },
    (_unused, index) => `sort_${String(index)}`,
  ).join(",");
  const sql = `f(${argumentsSql} ORDER BY ${sortSql}) trailing`;
  const { harness, kernel, result } = readFunction(
    sql,
    94,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const snapshot = harness.snapshot();
  const totalWork = result.cursor.workUnits;

  assert.equal(snapshot.calls, argumentCount + sortCount);
  assert.equal(snapshot.invocations.length, argumentCount + sortCount);
  assert.deepEqual(normalizedCalls(result), ["f"]);
  assert.equal(
    result.cursor.index,
    tokenIndexForRange(kernel, sourceRange(sql, "trailing", 0)),
  );
  assert.equal(totalWork < kernel.tokens.length * 25, true);
  for (const [index, invocation] of snapshot.invocations.entries()) {
    if (index > 0) {
      const previous = snapshot.invocations[index - 1];
      assert.ok(previous);
      assert.equal(previous.resultIndex < invocation.startIndex, true);
      assert.equal(previous.resultWorkUnits < invocation.startWorkUnits, true);
    }
  }
});

test("large decorator expression lists stay iterative within linear cursor work", (): void => {
  const itemCount = 500;
  const list = (prefix: string): string => Array.from(
    { length: itemCount },
    (_unused, index) => `${prefix}_${String(index)}`,
  ).join(",");
  const sql = [
    `f(${list("argument")})`,
    `WITHIN GROUP (ORDER BY ${list("within")})`,
    "FILTER (WHERE filter_value)",
    `OVER (PARTITION BY ${list("partition")}`,
    `ORDER BY ${list("window")} ROWS frame_value PRECEDING)`,
    "trailing",
  ].join(" ");
  const { harness, kernel, result } = readFunction(
    sql,
    103,
    DEFAULT_SQL_PARSER_LIMITS,
  );

  assert.equal(harness.snapshot().calls, itemCount * 4 + 2);
  assert.equal(
    result.cursor.index,
    tokenIndexForRange(kernel, sourceRange(sql, "trailing", 0)),
  );
  assert.equal(result.cursor.endIndex, kernel.tokens.length);
  assert.equal(result.cursor.depth, 0);
  assert.equal(result.cursor.workUnits < kernel.tokens.length * 30, true);
  assert.deepEqual(normalizedCalls(result), ["f"]);
});

test("function work accepts its exact maximum and fails at the first excess", (): void => {
  const sql = "f(first, second ORDER BY sorted DESC) FILTER (WHERE kept) OVER ()";
  const ample = readFunction(
    sql,
    95,
    limits(sql.length, 30, 6, 1_000),
  );
  const exactLimit = ample.result.cursor.workUnits;
  const exact = readFunction(
    sql,
    95,
    limits(sql.length, 30, 6, exactLimit),
  );
  assert.equal(exact.result.cursor.workUnits, exactLimit);

  const firstExcessLimits = limits(sql.length, 30, 6, exactLimit - 1);
  expectParserError(
    () => readFunction(sql, 95, firstExcessLimits),
    "limit_complexity",
    { start: sql.length, end: sql.length },
    `SQL parser Inspect trailing PostgreSQL function decorator exceeded maxWorkUnits=${String(exactLimit - 1)} at token 18`,
  );
});
