import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlParserKernel,
  createSqlTokenCursor,
  DEFAULT_SQL_PARSER_LIMITS,
  sqlTokenAt,
  type SqlParserLimits,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";
import {
  parsePostgreSqlTypedConstantAtCursor,
  parsePostgreSqlTypedConstantInfrastructure,
  parsePostgreSqlTypeNameAtCursor,
  parsePostgreSqlTypeNameInfrastructure,
} from "./sql-policy-type-parser.js";

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

const expectParserError = (
  action: () => unknown,
  code: SqlPolicyParserErrorCode,
  range: Readonly<{ start: number; end: number }> | null,
): SqlPolicyParserError => {
  let caught: unknown;
  try {
    action();
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof SqlPolicyParserError);
  assert.equal(caught.code, code);
  if (range !== null) {
    assert.deepEqual(caught.range, range);
  }
  return caught;
};

test("kernel builds one lossless linear delimiter index", (): void => {
  const sql = "numeric /* gap */ (10, (2))[]; interval day to second(3)";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);

  assert.equal(kernel.delimiters.scanSteps, kernel.tokens.length);
  assert.equal(kernel.statements.length, 2);
  assert.equal(kernel.statements[0]?.terminatorRange?.start, 29);
  assert.equal(
    kernel.sourceTokens.map((token) => token.text).join(""),
    sql,
  );
  for (const token of kernel.tokens) {
    assert.equal(sql.slice(token.range.start, token.range.end), token.text);
  }

  const openingIndexes = kernel.tokens
    .map((token, index) => ({ index, text: token.text }))
    .filter(({ text }) => text === "(" || text === "[")
    .map(({ index }) => index);
  assert.equal(kernel.delimiters.matchingIndexes.size, openingIndexes.length * 2);
  for (const openingIndex of openingIndexes) {
    const closingIndex = kernel.delimiters.matchingIndexes.get(openingIndex);
    assert.notEqual(closingIndex, undefined);
    assert.equal(
      kernel.delimiters.matchingIndexes.get(closingIndex as number),
      openingIndex,
    );
  }
});

test("kernel reports exact delimiter and numeric errors", (): void => {
  const mismatchCases: ReadonlyArray<Readonly<{
    message: string;
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      message: "Unexpected ) at offset 1; expected ] for opening [ at offset 0",
      range: { start: 1, end: 2 },
      sql: "[)",
    },
    {
      message: "Unexpected ] at offset 1; expected ) for opening ( at offset 0",
      range: { start: 1, end: 2 },
      sql: "(]",
    },
    {
      message: "Unexpected ) at offset 2; expected ] for opening [ at offset 1",
      range: { start: 2, end: 3 },
      sql: "([)]",
    },
  ];
  for (const mismatch of mismatchCases) {
    const error = expectParserError(
      () => createSqlParserKernel(
        mismatch.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_delimiter",
      mismatch.range,
    );
    assert.equal(error.message, mismatch.message);
  }

  const missingOpenCases: ReadonlyArray<Readonly<{
    message: string;
    sql: string;
  }>> = [
    {
      message: "Unexpected ) at offset 0; expected an opening (",
      sql: ")",
    },
    {
      message: "Unexpected ] at offset 0; expected an opening [",
      sql: "]",
    },
  ];
  for (const missingOpen of missingOpenCases) {
    const error = expectParserError(
      () => createSqlParserKernel(
        missingOpen.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_delimiter",
      { start: 0, end: 1 },
    );
    assert.equal(error.message, missingOpen.message);
  }

  const missing = expectParserError(
    () => createSqlParserKernel("(integer", DEFAULT_SQL_PARSER_LIMITS),
    "invalid_delimiter",
    { start: 0, end: 1 },
  );
  assert.match(missing.message, /Expected \)/u);

  const missingBracket = expectParserError(
    () => createSqlParserKernel("[integer", DEFAULT_SQL_PARSER_LIMITS),
    "invalid_delimiter",
    { start: 0, end: 1 },
  );
  assert.match(missingBracket.message, /Expected \]/u);

  const beforeTerminator = expectParserError(
    () => createSqlParserKernel("(integer;", DEFAULT_SQL_PARSER_LIMITS),
    "invalid_delimiter",
    { start: 0, end: 1 },
  );
  assert.match(beforeTerminator.message, /before the statement terminator/u);

  expectParserError(
    () => createSqlParserKernel("1e+", DEFAULT_SQL_PARSER_LIMITS),
    "invalid_numeric",
    { start: 0, end: 3 },
  );
});

test("kernel enforces token, nesting, and complexity budgets", (): void => {
  const tokenError = expectParserError(
    () => createSqlParserKernel("a b c", limits(100, 2, 8, 20)),
    "limit_tokens",
    { start: 4, end: 5 },
  );
  assert.match(tokenError.message, /maxTokens=2/u);

  const nested = `${"(".repeat(300)}x${")".repeat(300)}`;
  const nestingError = expectParserError(
    () => createSqlParserKernel(
      nested,
      limits(nested.length, 1_000, 64, 5_000),
    ),
    "limit_nesting",
    { start: 64, end: 65 },
  );
  assert.match(nestingError.message, /maxNestingDepth=64/u);
  assert.notEqual(nestingError.name, "RangeError");

  const complexityError = expectParserError(
    () => createSqlParserKernel("a b c d", limits(100, 10, 8, 3)),
    "limit_complexity",
    { start: 6, end: 7 },
  );
  assert.match(complexityError.message, /maxWorkUnits=3/u);

  expectParserError(
    () => createSqlParserKernel("integer", limits(100, 0, 8, 20)),
    "invalid_configuration",
    { start: 0, end: 0 },
  );
  expectParserError(
    () => createSqlParserKernel("integer", limits(0, 10, 8, 20)),
    "invalid_configuration",
    { start: 0, end: 0 },
  );
});

test("kernel source preflight bounds every UTF-16 source form before lexing", (): void => {
  const boundary = 64;
  const repeatedBlockComments = "/*x*/".repeat(10);
  const repeatedLineComments = "--x\n".repeat(10);
  const sourceAtLength = (
    prefix: string,
    length: number,
    suffix: string,
  ): string => {
    const paddingLength = length - prefix.length - suffix.length;
    assert.ok(paddingLength >= 0);
    return `${prefix}${" ".repeat(paddingLength)}${suffix}`;
  };
  const statementSource = (length: number): string =>
    `${"x;".repeat(Math.floor(length / 2))}${length % 2 === 0 ? "" : "x"}`;
  const cases: ReadonlyArray<Readonly<{
    at: string;
    below: string;
    label: string;
    over: string;
  }>> = [
    {
      at: " ".repeat(boundary),
      below: " ".repeat(boundary - 1),
      label: "whitespace",
      over: " ".repeat(boundary + 1),
    },
    {
      at: sourceAtLength(repeatedBlockComments, boundary, ""),
      below: sourceAtLength(repeatedBlockComments, boundary - 1, ""),
      label: "repeated block comments",
      over: sourceAtLength(repeatedBlockComments, boundary + 1, ""),
    },
    {
      at: sourceAtLength(repeatedLineComments, boundary, ""),
      below: sourceAtLength(repeatedLineComments, boundary - 1, ""),
      label: "repeated line comments",
      over: sourceAtLength(repeatedLineComments, boundary + 1, ""),
    },
    {
      at: "a".repeat(boundary),
      below: "a".repeat(boundary - 1),
      label: "single identifier token",
      over: "a".repeat(boundary + 1),
    },
    {
      at: sourceAtLength("'", boundary, "'"),
      below: sourceAtLength("'", boundary - 1, "'"),
      label: "single string token",
      over: sourceAtLength("'", boundary + 1, "'"),
    },
    {
      at: sourceAtLength("/*", boundary, "*/"),
      below: sourceAtLength("/*", boundary - 1, "*/"),
      label: "single block comment",
      over: sourceAtLength("/*", boundary + 1, "*/"),
    },
    {
      at: statementSource(boundary),
      below: statementSource(boundary - 1),
      label: "many statements",
      over: statementSource(boundary + 1),
    },
  ];

  for (const sourceCase of cases) {
    for (const sql of [sourceCase.below, sourceCase.at]) {
      assert.doesNotThrow(
        () => createSqlParserKernel(
          sql,
          limits(boundary, 1_000, 32, 2_000),
        ),
        `${sourceCase.label}: ${String(sql.length)}`,
      );
    }
    const error = expectParserError(
      () => createSqlParserKernel(
        sourceCase.over,
        limits(boundary, 1_000, 32, 2_000),
      ),
      "limit_source_length",
      { start: boundary, end: boundary + 1 },
    );
    assert.match(error.message, /UTF-16 code units/u, sourceCase.label);
    assert.match(error.message, /maxSourceCodeUnits=64/u, sourceCase.label);
  }

  const multibyteBoundary = 5;
  for (const sql of ["é😀x", "é😀xé"]) {
    assert.equal(sql.length, multibyteBoundary - 1 + (sql.endsWith("é") ? 1 : 0));
    assert.doesNotThrow(() =>
      createSqlParserKernel(
        sql,
        limits(multibyteBoundary, 10, 4, 20),
      ),
    );
  }
  const multibyteOver = "é😀xéx";
  assert.equal(multibyteOver.length, multibyteBoundary + 1);
  expectParserError(
    () => createSqlParserKernel(
      multibyteOver,
      limits(multibyteBoundary, 10, 4, 20),
    ),
    "limit_source_length",
    { start: multibyteBoundary, end: multibyteBoundary + 1 },
  );

  for (const invalidBeforeBoundary of [
    `\0${"x".repeat(boundary)}`,
    `\uD800${"x".repeat(boundary)}`,
  ]) {
    expectParserError(
      () => createSqlParserKernel(
        invalidBeforeBoundary,
        limits(boundary, 10, 4, 20),
      ),
      "limit_source_length",
      { start: boundary, end: boundary + 1 },
    );
  }
});

test("hostile delimiter nesting is iterative and charged once", (): void => {
  const depth = 20_000;
  const sql = `${"(".repeat(depth)}x${")".repeat(depth)}`;
  const kernel = createSqlParserKernel(
    sql,
    limits(sql.length, sql.length + 1, depth + 1, sql.length + 1),
  );

  assert.equal(kernel.tokens.length, (depth * 2) + 1);
  assert.equal(kernel.delimiters.scanSteps, kernel.tokens.length);
  assert.equal(
    kernel.delimiters.matchingIndexes.get(0),
    kernel.tokens.length - 1,
  );
});

test("cursor consumers expose deterministic work accounting", (): void => {
  const sql = "numeric(10, 2) trailing";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const cursor = createSqlTokenCursor(kernel, 0, kernel.tokens.length);
  const parsed = parsePostgreSqlTypeNameAtCursor(cursor, "typename");

  assert.notEqual(parsed, null);
  assert.equal(parsed?.node.sql, "numeric(10, 2)");
  assert.equal(parsed?.cursor.index, 6);
  assert.equal(
    parsed?.cursor.workUnits,
    kernel.delimiters.scanSteps + 6,
  );
  assert.equal(kernel.tokens[parsed?.cursor.index]?.text, "trailing");

  expectParserError(
    () => parsePostgreSqlTypeNameInfrastructure(
      "numeric(10, 2)",
      limits(100, 20, 8, 9),
    ),
    "limit_complexity",
    null,
  );
});

test("cursor token access enforces both bounds and safe offsets", (): void => {
  const kernel = createSqlParserKernel(
    "first; second",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const cursor = createSqlTokenCursor(kernel, 2, 3);

  assert.equal(sqlTokenAt(cursor, 0)?.text, "second");
  assert.equal(sqlTokenAt(cursor, 1), undefined);
  assert.equal(sqlTokenAt(cursor, 100), undefined);

  for (const offset of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const error = expectParserError(
      () => sqlTokenAt(cursor, offset),
      "internal_invariant",
      { start: 7, end: 13 },
    );
    assert.match(error.message, /SQL token (?:offset|index overflow)/u);
  }
});

test("multi-token work charges report the exact first excess token", (): void => {
  const cases: ReadonlyArray<Readonly<{
    requiredWorkUnits: number;
    sql: string;
  }>> = [
    { requiredWorkUnits: 4, sql: "double precision" },
    { requiredWorkUnits: 8, sql: "timestamp with time zone" },
    { requiredWorkUnits: 16, sql: "numeric(((1)))" },
    { requiredWorkUnits: 6, sql: "schema.type" },
  ];

  for (const workCase of cases) {
    const baseline = createSqlParserKernel(
      workCase.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const lastToken = baseline.tokens.at(-1);
    assert.notEqual(lastToken, undefined);
    const below = workCase.requiredWorkUnits - 1;
    const error = expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        workCase.sql,
        limits(workCase.sql.length, 100, 20, below),
      ),
      "limit_complexity",
      lastToken?.range ?? null,
    );
    assert.match(
      error.message,
      new RegExp(`at token ${String(baseline.tokens.length - 1)}$`, "u"),
      workCase.sql,
    );

    for (const maxWorkUnits of [
      workCase.requiredWorkUnits,
      workCase.requiredWorkUnits + 1,
    ]) {
      assert.equal(
        parsePostgreSqlTypeNameInfrastructure(
          workCase.sql,
          limits(workCase.sql.length, 100, 20, maxWorkUnits),
        ).sql,
        workCase.sql,
      );
    }
  }
});

test("Typename records qualified names, modifiers, arrays, and exact ranges", (): void => {
  const sql = `  "SomeSchema" /* path */ . "MyType"(7, 'x', mod) [2][]  `;
  const node = parsePostgreSqlTypeNameInfrastructure(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );

  assert.equal(
    node.sql,
    `"SomeSchema" /* path */ . "MyType"(7, 'x', mod) [2][]`,
  );
  assert.deepEqual(node.range, { start: 2, end: sql.length - 2 });
  assert.equal(
    sql.slice(node.nameRange.start, node.nameRange.end),
    `"SomeSchema" /* path */ . "MyType"`,
  );
  assert.deepEqual(
    node.nameParts.map((part) => ({
      normalized: part.normalized,
      quoted: part.quoted,
      range: part.range,
    })),
    [
      {
        normalized: "SomeSchema",
        quoted: true,
        range: { start: 2, end: 14 },
      },
      {
        normalized: "MyType",
        quoted: true,
        range: { start: 28, end: 36 },
      },
    ],
  );
  assert.deepEqual(
    node.modifiers.map((modifier) => ({
      kind: modifier.kind,
      range: modifier.range,
      sql: modifier.sql,
    })),
    [
      { kind: "numeric", range: { start: 37, end: 38 }, sql: "7" },
      { kind: "string", range: { start: 40, end: 43 }, sql: "'x'" },
      { kind: "identifier", range: { start: 45, end: 48 }, sql: "mod" },
    ],
  );
  assert.deepEqual(
    node.arrayBounds.map((bound) => ({
      notation: bound.notation,
      range: bound.range,
      size: bound.size,
    })),
    [
      {
        notation: "brackets",
        range: { start: 50, end: 53 },
        size: "2",
      },
      {
        notation: "brackets",
        range: { start: 53, end: 55 },
        size: null,
      },
    ],
  );
});

test("Typename iteratively unwraps PostgreSQL simple modifier expressions", (): void => {
  for (const sql of [
    "numeric((1))",
    "numeric(((1)))",
    "numeric(- -1)",
    "numeric(2,((-1)))",
  ]) {
    assert.equal(
      parsePostgreSqlTypeNameInfrastructure(
        sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      sql,
    );
  }

  const sql = "custom_type(((1)), ((mode)), (('x')), - -1, -((1)))";
  const node = parsePostgreSqlTypeNameInfrastructure(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    node.modifiers.map((modifier) => ({
      kind: modifier.kind,
      normalizedValue: modifier.normalizedValue,
      sql: modifier.sql,
      valueSql: sql.slice(
        modifier.valueRange.start,
        modifier.valueRange.end,
      ),
    })),
    [
      {
        kind: "numeric",
        normalizedValue: "1",
        sql: "((1))",
        valueSql: "1",
      },
      {
        kind: "identifier",
        normalizedValue: "mode",
        sql: "((mode))",
        valueSql: "mode",
      },
      {
        kind: "string",
        normalizedValue: "x",
        sql: "(('x'))",
        valueSql: "'x'",
      },
      {
        kind: "numeric",
        normalizedValue: "1",
        sql: "- -1",
        valueSql: "1",
      },
      {
        kind: "numeric",
        normalizedValue: "-1",
        sql: "-((1))",
        valueSql: "1",
      },
    ],
  );

  const wrapped = parsePostgreSqlTypeNameInfrastructure(
    "numeric((1))",
    DEFAULT_SQL_PARSER_LIMITS,
  ).modifiers[0];
  assert.deepEqual(wrapped?.range, { start: 8, end: 11 });
  assert.deepEqual(wrapped?.valueRange, { start: 9, end: 10 });

  const kernel = createSqlParserKernel(
    "numeric(((1)))",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const cursor = createSqlTokenCursor(kernel, 0, kernel.tokens.length);
  const parsed = parsePostgreSqlTypeNameAtCursor(cursor, "typename");
  assert.equal(
    parsed?.cursor.workUnits,
    kernel.delimiters.scanSteps + kernel.tokens.length,
  );
});

test("unary plus remains a non-simple PostgreSQL type modifier", (): void => {
  const invalidModifiers: ReadonlyArray<string> = [
    "+1",
    "(+1)",
    "+(1)",
    "++1",
    "+-1",
    "-+1",
    "+1.0",
    "((+1.0))",
  ];
  for (const modifier of invalidModifiers) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        `custom_type(${modifier})`,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_modifier",
      null,
    );
    expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        `custom_type(${modifier}) 'value'`,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_modifier",
      null,
    );
  }

  const direct = parsePostgreSqlTypeNameInfrastructure(
    "custom_type(- -0001, - - -1_000.0, ((- -0x10)))",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    direct.modifiers.map((modifier) => modifier.normalizedValue),
    ["1", "-1_000.0", "16"],
  );

  const typed = parsePostgreSqlTypedConstantInfrastructure(
    "custom_type((- -0001), ((- - -1.0))) 'value'",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    typed.typeName.modifiers.map(
      (modifier) => modifier.normalizedValue,
    ),
    ["1", "-1.0"],
  );
});

test("type modifier identifiers follow PostgreSQL ColumnRef semantics", (): void => {
  const invalidTypenames: ReadonlyArray<Readonly<{
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      range: { start: 8, end: 22 },
      sql: "numeric(current_schema)",
    },
    {
      range: { start: 10, end: 24 },
      sql: "numeric(((current_schema)))",
    },
    {
      range: { start: 12, end: 18 },
      sql: "custom_type(binary)",
    },
    {
      range: { start: 12, end: 17 },
      sql: "custom_type(cross)",
    },
    {
      range: { start: 12, end: 19 },
      sql: "custom_type(verbose)",
    },
    {
      range: { start: 12, end: 24 },
      sql: "custom_type(current_user)",
    },
  ];
  for (const invalid of invalidTypenames) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        invalid.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_modifier",
      invalid.range,
    );
  }

  for (const invalid of [
    "custom_type(current_schema) 'value'",
    "custom_type(((current_schema))) 'value'",
  ]) {
    expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        invalid,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_modifier",
      null,
    );
  }

  const validSql =
    `custom_type("current_schema", mode, by, numeric, "binary")`;
  const valid = parsePostgreSqlTypeNameInfrastructure(
    validSql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    valid.modifiers.map((modifier) => ({
      kind: modifier.kind,
      normalizedValue: modifier.normalizedValue,
      sql: modifier.sql,
      valueSql: validSql.slice(
        modifier.valueRange.start,
        modifier.valueRange.end,
      ),
    })),
    [
      {
        kind: "identifier",
        normalizedValue: "current_schema",
        sql: `"current_schema"`,
        valueSql: `"current_schema"`,
      },
      {
        kind: "identifier",
        normalizedValue: "mode",
        sql: "mode",
        valueSql: "mode",
      },
      {
        kind: "identifier",
        normalizedValue: "by",
        sql: "by",
        valueSql: "by",
      },
      {
        kind: "identifier",
        normalizedValue: "numeric",
        sql: "numeric",
        valueSql: "numeric",
      },
      {
        kind: "identifier",
        normalizedValue: "binary",
        sql: `"binary"`,
        valueSql: `"binary"`,
      },
    ],
  );

  const typedQuoted = parsePostgreSqlTypedConstantInfrastructure(
    `custom_type((("current_schema"))) 'value'`,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.equal(
    typedQuoted.typeName.modifiers[0]?.normalizedValue,
    "current_schema",
  );

  for (const typeName of ["current_schema", "current_schema.member"]) {
    assert.equal(
      parsePostgreSqlTypeNameInfrastructure(
        typeName,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      typeName,
    );
  }
  for (const typedConstant of [
    "current_schema 'value'",
    "current_schema(mode) 'value'",
  ]) {
    assert.equal(
      parsePostgreSqlTypedConstantInfrastructure(
        typedConstant,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      typedConstant,
    );
  }
});

test("qualified typed constants follow PostgreSQL ColId categories", (): void => {
  const typeFunctionKeywords: ReadonlyArray<string> = [
    "authorization",
    "binary",
    "collation",
    "concurrently",
    "cross",
    "current_schema",
    "freeze",
    "full",
    "ilike",
    "inner",
    "is",
    "isnull",
    "join",
    "left",
    "like",
    "natural",
    "notnull",
    "outer",
    "overlaps",
    "right",
    "similar",
    "tablesample",
    "verbose",
  ];
  for (const keyword of typeFunctionKeywords) {
    const sql = `${keyword}.member 'value'`;
    const error = expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_typed_constant",
      { start: keyword.length, end: keyword.length + 1 },
    );
    assert.match(error.message, /require a ColId before \./u);
  }

  for (const reserved of ["select", "current_user"]) {
    const sql = `${reserved}.member 'value'`;
    expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_typed_constant",
      { start: reserved.length, end: reserved.length + 1 },
    );
  }

  for (const valid of [
    `schema.member 'value'`,
    `by.member 'value'`,
    `numeric.member 'value'`,
    `"current_schema".member 'value'`,
    `"select".member 'value'`,
  ]) {
    assert.equal(
      parsePostgreSqlTypedConstantInfrastructure(
        valid,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      valid,
    );
  }

  for (const unqualified of [
    `current_schema 'value'`,
    `binary 'value'`,
    `cross 'value'`,
  ]) {
    assert.equal(
      parsePostgreSqlTypedConstantInfrastructure(
        unqualified,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      unqualified,
    );
  }

  for (const typeName of [
    "current_schema.member",
    "binary.member",
    "cross.member",
  ]) {
    assert.equal(
      parsePostgreSqlTypeNameInfrastructure(
        typeName,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      typeName,
    );
  }
});

test("numeric modifier semantics match PostgreSQL ICONST and FCONST actions", (): void => {
  const sql =
    "custom_type(0001, 0b1_000, 0o10, 0Xf_F, 1_000.0, 1.0E+2, 2_147_483_648, - -0x10, - - -1_000.0)";
  const node = parsePostgreSqlTypeNameInfrastructure(
    sql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    node.modifiers.map((modifier) => ({
      normalizedValue: modifier.normalizedValue,
      sql: modifier.sql,
      valueSql: sql.slice(
        modifier.valueRange.start,
        modifier.valueRange.end,
      ),
    })),
    [
      { normalizedValue: "1", sql: "0001", valueSql: "0001" },
      { normalizedValue: "8", sql: "0b1_000", valueSql: "0b1_000" },
      { normalizedValue: "8", sql: "0o10", valueSql: "0o10" },
      { normalizedValue: "255", sql: "0Xf_F", valueSql: "0Xf_F" },
      { normalizedValue: "1_000.0", sql: "1_000.0", valueSql: "1_000.0" },
      { normalizedValue: "1.0E+2", sql: "1.0E+2", valueSql: "1.0E+2" },
      {
        normalizedValue: "2_147_483_648",
        sql: "2_147_483_648",
        valueSql: "2_147_483_648",
      },
      { normalizedValue: "16", sql: "- -0x10", valueSql: "0x10" },
      {
        normalizedValue: "-1_000.0",
        sql: "- - -1_000.0",
        valueSql: "1_000.0",
      },
    ],
  );

  const typedSql =
    "custom_type(00_01, 0Xf_F, 1_000.0, - - -2_147_483_648) 'value'";
  const typed = parsePostgreSqlTypedConstantInfrastructure(
    typedSql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    typed.typeName.modifiers.map((modifier) => modifier.normalizedValue),
    ["1", "255", "1_000.0", "-2_147_483_648"],
  );
  assert.equal(typed.sql, typedSql);
});

test("Iconst-only type syntax uses canonical exact integer values", (): void => {
  const bracketArrays = parsePostgreSqlTypeNameInfrastructure(
    "integer[0004][0b100][0o10][0X10]",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.deepEqual(
    bracketArrays.arrayBounds.map((bound) => bound.size),
    ["4", "4", "8", "16"],
  );

  const array = parsePostgreSqlTypeNameInfrastructure(
    "integer ARRAY[0Xf_F]",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.equal(array.arrayBounds[0]?.size, "255");
  assert.equal(
    parsePostgreSqlTypeNameInfrastructure(
      "integer[0X7FFF_FFFF]",
      DEFAULT_SQL_PARSER_LIMITS,
    ).arrayBounds[0]?.size,
    "2147483647",
  );
  assert.equal(
    parsePostgreSqlTypeNameInfrastructure(
      "char(2_147_483_647)",
      DEFAULT_SQL_PARSER_LIMITS,
    ).modifiers[0]?.normalizedValue,
    "2147483647",
  );

  const interval = parsePostgreSqlTypeNameInfrastructure(
    "interval day to second(0X3)",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.equal(interval.intervalQualifier?.secondPrecision, "3");
  assert.equal(interval.intervalQualifier?.sql, "day to second(0X3)");

  const typed = parsePostgreSqlTypedConstantInfrastructure(
    "interval(00_03) '1.234'",
    DEFAULT_SQL_PARSER_LIMITS,
  );
  assert.equal(typed.typeName.modifiers[0]?.normalizedValue, "3");
  assert.equal(
    parsePostgreSqlTypeNameInfrastructure(
      "float(0x35)",
      DEFAULT_SQL_PARSER_LIMITS,
    ).modifiers[0]?.normalizedValue,
    "53",
  );

  const invalidCases: ReadonlyArray<Readonly<{
    code: SqlPolicyParserErrorCode;
    sql: string;
  }>> = [
    { code: "invalid_type_modifier", sql: "char(2147483648)" },
    { code: "invalid_type_modifier", sql: "float(0x36)" },
    { code: "invalid_type_modifier", sql: "interval(0X80000000)" },
    {
      code: "invalid_type_modifier",
      sql: "interval second(2_147_483_648)",
    },
    { code: "invalid_type_name", sql: "integer[2147483648]" },
    { code: "invalid_type_name", sql: "integer ARRAY[0X80000000]" },
  ];
  for (const invalid of invalidCases) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        invalid.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      invalid.code,
      null,
    );
  }
});

test("Typename rejects malformed or over-budget modifier wrappers", (): void => {
  const invalidCases: ReadonlyArray<Readonly<{
    code: SqlPolicyParserErrorCode;
    sql: string;
  }>> = [
    { code: "invalid_type_modifier", sql: "numeric(())" },
    { code: "invalid_type_modifier", sql: "numeric((1)+)" },
    { code: "invalid_type_modifier", sql: "numeric((+1))" },
    { code: "invalid_type_modifier", sql: "numeric((+mode))" },
    { code: "invalid_type_modifier", sql: "numeric((1,2))" },
    { code: "invalid_delimiter", sql: "numeric((1)" },
  ];
  for (const invalid of invalidCases) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        invalid.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      invalid.code,
      null,
    );
  }

  const nested = "numeric((((1))))";
  expectParserError(
    () => parsePostgreSqlTypeNameInfrastructure(
      nested,
      limits(nested.length, 50, 2, 100),
    ),
    "limit_nesting",
    null,
  );
  const tokenCount = createSqlParserKernel(
    nested,
    DEFAULT_SQL_PARSER_LIMITS,
  ).tokens.length;
  expectParserError(
    () => parsePostgreSqlTypeNameInfrastructure(
      nested,
      limits(nested.length, 50, 20, tokenCount + 2),
    ),
    "limit_complexity",
    null,
  );
});

test("type delimiter consumers reject closes outside bounded cursors", (): void => {
  const cases: ReadonlyArray<Readonly<{
    code: "invalid_type_modifier" | "invalid_type_name";
    endIndex: number;
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      code: "invalid_type_modifier",
      endIndex: 3,
      range: { start: 4, end: 5 },
      sql: "char(3)",
    },
    {
      code: "invalid_type_name",
      endIndex: 3,
      range: { start: 7, end: 8 },
      sql: "integer[3]",
    },
    {
      code: "invalid_type_name",
      endIndex: 2,
      range: { start: 7, end: 8 },
      sql: "integer[]",
    },
    {
      code: "invalid_type_name",
      endIndex: 4,
      range: { start: 13, end: 14 },
      sql: "integer ARRAY[3]",
    },
    {
      code: "invalid_type_modifier",
      endIndex: 7,
      range: { start: 11, end: 12 },
      sql: "custom_type(((1)))",
    },
  ];

  for (const boundedCase of cases) {
    const kernel = createSqlParserKernel(
      boundedCase.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const complete = parsePostgreSqlTypeNameAtCursor(
      createSqlTokenCursor(kernel, 0, kernel.tokens.length),
      "typename",
    );
    assert.equal(complete?.cursor.index, kernel.tokens.length);

    const error = expectParserError(
      () => parsePostgreSqlTypeNameAtCursor(
        createSqlTokenCursor(kernel, 0, boundedCase.endIndex),
        "typename",
      ),
      boundedCase.code,
      boundedCase.range,
    );
    assert.doesNotMatch(error.message, /internal invariant/iu);
    assert.match(error.message, /outside the current parse range/u);
  }
});

test("datetime timezone parsing mirrors PostgreSQL lookahead", (): void => {
  const validCases: ReadonlyArray<Readonly<{
    kind: "with" | "without";
    sql: string;
    typeSql: string;
  }>> = [
    {
      kind: "with",
      sql: "timestamp with time zone trailing",
      typeSql: "timestamp with time zone",
    },
    {
      kind: "without",
      sql: "time without time zone trailing",
      typeSql: "time without time zone",
    },
    {
      kind: "with",
      sql: "timestamp(3) with time zone trailing",
      typeSql: "timestamp(3) with time zone",
    },
  ];
  for (const valid of validCases) {
    const kernel = createSqlParserKernel(
      valid.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const parsed = parsePostgreSqlTypeNameAtCursor(
      createSqlTokenCursor(kernel, 0, kernel.tokens.length),
      "typename",
    );
    if (parsed === null) {
      assert.fail(`Expected PostgreSQL datetime type: ${valid.sql}`);
    }
    assert.equal(parsed.node.sql, valid.typeSql);
    assert.equal(parsed.node.timeZone?.kind, valid.kind);
    assert.equal(sqlTokenAt(parsed.cursor, 0)?.text, "trailing");
  }

  const ordinaryNeighbors: ReadonlyArray<Readonly<{
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      range: { start: 10, end: 14 },
      sql: "timestamp with foo",
    },
    {
      range: { start: 10, end: 17 },
      sql: "timestamp without foo",
    },
    {
      range: { start: 10, end: 17 },
      sql: "timestamp without ordinality",
    },
    {
      range: { start: 10, end: 16 },
      sql: `timestamp "with" time zone`,
    },
    {
      range: { start: 10, end: 14 },
      sql: `timestamp with "time" zone`,
    },
    {
      range: { start: 10, end: 14 },
      sql: `timestamp with "ordinality"`,
    },
  ];
  for (const neighbor of ordinaryNeighbors) {
    const kernel = createSqlParserKernel(
      neighbor.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const cursor = createSqlTokenCursor(kernel, 0, kernel.tokens.length);
    const parsed = parsePostgreSqlTypeNameAtCursor(cursor, "typename");
    assert.equal(parsed?.node.sql, "timestamp");
    assert.equal(parsed?.node.timeZone, null);
    assert.equal(parsed?.cursor.index, 1);

    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        neighbor.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "unexpected_token",
      neighbor.range,
    );
  }

  const committedInvalid: ReadonlyArray<Readonly<{
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      range: { start: 20, end: 26 },
      sql: `timestamp with time "zone"`,
    },
    {
      range: { start: 20, end: 23 },
      sql: "timestamp with time foo",
    },
    {
      range: { start: 18, end: 21 },
      sql: "time without time foo",
    },
    {
      range: { start: 15, end: 25 },
      sql: "timestamp with ordinality",
    },
  ];
  for (const invalid of committedInvalid) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        invalid.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_name",
      invalid.range,
    );
  }
});

test("Typename accepts PostgreSQL 18 built-in and array productions", (): void => {
  const cases: ReadonlyArray<Readonly<{
    arrays: ReadonlyArray<Readonly<{
      notation: "array" | "brackets";
      size: string | null;
    }>>;
    form: string;
    modifiers: ReadonlyArray<string>;
    qualifier: string | null;
    sql: string;
    timeZone: "with" | "without" | null;
  }>> = [
    {
      arrays: [],
      form: "integer",
      modifiers: [],
      qualifier: null,
      sql: "setof integer",
      timeZone: null,
    },
    {
      arrays: [{ notation: "array", size: "4" }],
      form: "double_precision",
      modifiers: [],
      qualifier: null,
      sql: "double precision ARRAY[4]",
      timeZone: null,
    },
    {
      arrays: [{ notation: "brackets", size: null }],
      form: "timestamp",
      modifiers: ["3"],
      qualifier: null,
      sql: "timestamp(3) with time zone[]",
      timeZone: "with",
    },
    {
      arrays: [],
      form: "character",
      modifiers: ["20"],
      qualifier: null,
      sql: "national character varying(20)",
      timeZone: null,
    },
    {
      arrays: [{ notation: "brackets", size: null }],
      form: "interval",
      modifiers: [],
      qualifier: "day to second(6)",
      sql: "interval day to second(6)[]",
      timeZone: null,
    },
    {
      arrays: [],
      form: "interval",
      modifiers: ["3"],
      qualifier: null,
      sql: "interval(3)",
      timeZone: null,
    },
    {
      arrays: [
        { notation: "brackets", size: "2" },
        { notation: "brackets", size: "3" },
      ],
      form: "integer",
      modifiers: [],
      qualifier: null,
      sql: "integer[2][3]",
      timeZone: null,
    },
    {
      arrays: [{ notation: "array", size: null }],
      form: "bit",
      modifiers: ["8"],
      qualifier: null,
      sql: "bit varying(8) ARRAY",
      timeZone: null,
    },
    {
      arrays: [],
      form: "generic",
      modifiers: ["10", "2"],
      qualifier: null,
      sql: "pg_catalog.numeric(10, 2)",
      timeZone: null,
    },
  ];

  for (const expected of cases) {
    const node = parsePostgreSqlTypeNameInfrastructure(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    assert.equal(node.form, expected.form, expected.sql);
    assert.equal(node.intervalQualifier?.sql ?? null, expected.qualifier);
    assert.deepEqual(
      node.modifiers.map((modifier) => modifier.sql),
      expected.modifiers,
      expected.sql,
    );
    assert.deepEqual(
      node.arrayBounds.map((bound) => ({
        notation: bound.notation,
        size: bound.size,
      })),
      expected.arrays,
      expected.sql,
    );
    assert.equal(node.timeZone?.kind ?? null, expected.timeZone);
  }

  for (const sql of ["float(1)", "float(24)", "float(25)", "float(53)"]) {
    assert.equal(
      parsePostgreSqlTypeNameInfrastructure(
        sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ).sql,
      sql,
    );
  }
});

test("Typename rejects invalid PostgreSQL 18 neighboring productions", (): void => {
  const cases: ReadonlyArray<Readonly<{
    code: SqlPolicyParserErrorCode;
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      code: "invalid_type_name",
      range: { start: 10, end: 15 },
      sql: "integer[] ARRAY",
    },
    {
      code: "invalid_type_name",
      range: { start: 11, end: 16 },
      sql: "integer[2] ARRAY[3]",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 4, end: 5 },
      sql: "json(1)",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 6, end: 7 },
      sql: "float(0)",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 6, end: 8 },
      sql: "float(54)",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 12, end: 15 },
      sql: "interval(3) day to second",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 10, end: 11 },
      sql: "numeric(1 +)",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 5, end: 8 },
      sql: "char(foo)",
    },
    {
      code: "invalid_type_name",
      range: { start: 14, end: 15 },
      sql: "integer ARRAY[]",
    },
    {
      code: "invalid_type_modifier",
      range: { start: 17, end: 20 },
      sql: "interval year to day",
    },
  ];

  for (const expected of cases) {
    expectParserError(
      () => parsePostgreSqlTypeNameInfrastructure(
        expected.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      expected.code,
      expected.range,
    );
  }
});

test("typed-constant speculation preserves generic function applications", (): void => {
  const functionCases: ReadonlyArray<Readonly<{
    nameWorkUnits: number;
    sql: string;
  }>> = [
    { nameWorkUnits: 1, sql: "foo()" },
    { nameWorkUnits: 1, sql: "foo(1 + 2)" },
    { nameWorkUnits: 1, sql: "foo(current_schema)" },
    { nameWorkUnits: 3, sql: "schema.foo(((1 + 2)))" },
  ];
  for (const functionCase of functionCases) {
    const baseline = createSqlParserKernel(
      functionCase.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    const kernel = createSqlParserKernel(
      functionCase.sql,
      limits(
        functionCase.sql.length,
        baseline.tokens.length,
        DEFAULT_SQL_PARSER_LIMITS.maxNestingDepth,
        baseline.delimiters.scanSteps + functionCase.nameWorkUnits,
      ),
    );
    const cursor = createSqlTokenCursor(kernel, 0, kernel.tokens.length);

    assert.equal(parsePostgreSqlTypedConstantAtCursor(cursor), null);
    assert.equal(cursor.index, 0);
    assert.equal(cursor.workUnits, kernel.delimiters.scanSteps);
    assert.equal(kernel.delimiters.scanSteps, kernel.tokens.length);
  }

  const boundedSql = "foo(1) 'value' trailing";
  const boundedKernel = createSqlParserKernel(
    boundedSql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const closeIndex = boundedKernel.delimiters.matchingIndexes.get(1);
  assert.equal(closeIndex, 3);
  for (const endIndex of [3, 4]) {
    assert.equal(
      parsePostgreSqlTypedConstantAtCursor(
        createSqlTokenCursor(boundedKernel, 0, endIndex),
      ),
      null,
    );
  }

  const committedErrors: ReadonlyArray<Readonly<{
    range: Readonly<{ start: number; end: number }>;
    sql: string;
  }>> = [
    {
      range: { start: 3, end: 4 },
      sql: "foo() 'value'",
    },
    {
      range: { start: 5, end: 6 },
      sql: "foo(1+2) 'value'",
    },
    {
      range: { start: 4, end: 18 },
      sql: "foo(current_schema) 'value'",
    },
  ];
  for (const committed of committedErrors) {
    expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        committed.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      "invalid_type_modifier",
      committed.range,
    );
  }

  const committedSql = "foo(((1))) 'value' + trailing";
  const committedKernel = createSqlParserKernel(
    committedSql,
    DEFAULT_SQL_PARSER_LIMITS,
  );
  const committed = parsePostgreSqlTypedConstantAtCursor(
    createSqlTokenCursor(
      committedKernel,
      0,
      committedKernel.tokens.length,
    ),
  );
  if (committed === null) {
    assert.fail("Expected committed PostgreSQL typed constant");
  }
  assert.equal(committed.node.sql, "foo(((1))) 'value'");
  assert.equal(committed.node.typeName.modifiers[0]?.normalizedValue, "1");
  assert.equal(sqlTokenAt(committed.cursor, 0)?.text, "+");
  assert.equal(
    committed.cursor.workUnits,
    committedKernel.delimiters.scanSteps + committed.cursor.index,
  );
});

test("typed constants follow ConstTypename and interval productions", (): void => {
  const cases: ReadonlyArray<Readonly<{
    form: string;
    qualifier: string | null;
    sql: string;
    typeSql: string;
    value: string;
  }>> = [
    {
      form: "generic",
      qualifier: null,
      sql: "schema.money(10, 2) '12.30'",
      typeSql: "schema.money(10, 2)",
      value: "12.30",
    },
    {
      form: "double_precision",
      qualifier: null,
      sql: "double precision '1.2'",
      typeSql: "double precision",
      value: "1.2",
    },
    {
      form: "interval",
      qualifier: "day to second(3)",
      sql: "interval '1 day' day to second(3)",
      typeSql: "interval",
      value: "1 day",
    },
    {
      form: "interval",
      qualifier: null,
      sql: "interval(3) '1.234'",
      typeSql: "interval(3)",
      value: "1.234",
    },
    {
      form: "json",
      qualifier: null,
      sql: `json '{"a":1}'`,
      typeSql: "json",
      value: '{"a":1}',
    },
    {
      form: "generic",
      qualifier: null,
      sql: `integer.payload '1'`,
      typeSql: "integer.payload",
      value: "1",
    },
  ];

  for (const expected of cases) {
    const node = parsePostgreSqlTypedConstantInfrastructure(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    assert.equal(node.sql, expected.sql);
    assert.deepEqual(node.range, { start: 0, end: expected.sql.length });
    assert.equal(node.typeName.form, expected.form);
    assert.equal(node.typeName.sql, expected.typeSql);
    assert.equal(node.value.semanticValue, expected.value);
    assert.equal(node.intervalQualifier?.sql ?? null, expected.qualifier);
    assert.equal(node.typeName.arrayBounds.length, 0);
    assert.equal(node.typeName.setOf, false);
  }
});

test("typed constants accept PostgreSQL parenthesized simple modifiers", (): void => {
  const cases: ReadonlyArray<Readonly<{
    modifier: string;
    normalizedValue: string;
    sql: string;
  }>> = [
    {
      modifier: "(1)",
      normalizedValue: "1",
      sql: "numeric((1)) '1'",
    },
    {
      modifier: "((1))",
      normalizedValue: "1",
      sql: "numeric(((1))) '1'",
    },
    {
      modifier: "(mode)",
      normalizedValue: "mode",
      sql: "custom_type((mode)) 'value'",
    },
  ];
  for (const expected of cases) {
    const node = parsePostgreSqlTypedConstantInfrastructure(
      expected.sql,
      DEFAULT_SQL_PARSER_LIMITS,
    );
    assert.equal(node.sql, expected.sql);
    assert.equal(node.typeName.modifiers[0]?.sql, expected.modifier);
    assert.equal(
      node.typeName.modifiers[0]?.normalizedValue,
      expected.normalizedValue,
    );
  }
});

test("typed constants reject casts, named modifiers, and malformed intervals", (): void => {
  const cases: ReadonlyArray<Readonly<{
    code: SqlPolicyParserErrorCode;
    sql: string;
  }>> = [
    { code: "invalid_typed_constant", sql: "integer[] '1'" },
    { code: "invalid_typed_constant", sql: "interval(3) '1' day" },
    { code: "invalid_type_modifier", sql: "foo() 'x'" },
    { code: "invalid_type_modifier", sql: "foo(1 => 2) 'x'" },
    { code: "invalid_type_modifier", sql: "interval '1' year to day" },
    { code: "invalid_typed_constant", sql: "bit B'1'" },
    { code: "unexpected_token", sql: "integer '1' trailing" },
  ];

  for (const expected of cases) {
    expectParserError(
      () => parsePostgreSqlTypedConstantInfrastructure(
        expected.sql,
        DEFAULT_SQL_PARSER_LIMITS,
      ),
      expected.code,
      null,
    );
  }
});

test("typed-constant cursor parsing leaves neighboring expression tokens", (): void => {
  const sql = "interval '2' hour + value";
  const kernel = createSqlParserKernel(sql, DEFAULT_SQL_PARSER_LIMITS);
  const cursor = createSqlTokenCursor(kernel, 0, kernel.tokens.length);
  const parsed = parsePostgreSqlTypedConstantAtCursor(cursor);

  assert.notEqual(parsed, null);
  assert.equal(parsed?.node.sql, "interval '2' hour");
  assert.equal(parsed?.node.intervalQualifier?.sql, "hour");
  assert.equal(kernel.tokens[parsed?.cursor.index]?.text, "+");
});
