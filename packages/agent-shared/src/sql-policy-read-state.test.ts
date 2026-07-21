import assert from "node:assert/strict";
import test from "node:test";
import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  createSqlParserKernel,
  type SqlParserKernel,
  type SqlParserLimits,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";
import {
  checkedSqlReadDepth,
  createSqlReadState,
  sqlReadRangeAt,
  sqlReadRangeForSpan,
} from "./sql-policy-read-state.js";

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
  action: () => void,
  code: SqlPolicyParserErrorCode,
  range: SqlSourceRange,
  message: RegExp,
): void => assert.throws(action, (error: unknown): boolean => {
  assert.ok(error instanceof SqlPolicyParserError);
  assert.equal(error.code, code);
  assert.deepEqual(error.range, range);
  assert.match(error.message, message);
  return true;
});

test("read state is a frozen constant-time view of the canonical kernel", (): void => {
  const cases: ReadonlyArray<Readonly<{
    kernel: SqlParserKernel;
    sourceLength: number;
    tokenCount: number;
    delimiterScanWorkUnits: number;
  }>> = [
    {
      delimiterScanWorkUnits: 0,
      kernel: createSqlParserKernel("", limits(10, 10, 4, 10)),
      sourceLength: 0,
      tokenCount: 0,
    },
    {
      delimiterScanWorkUnits: 4,
      kernel: createSqlParserKernel(
        "select (1)",
        limits(20, 10, 4, 20),
      ),
      sourceLength: 10,
      tokenCount: 4,
    },
  ];

  for (const expected of cases) {
    const { kernel } = expected;
    const state = createSqlReadState(kernel);

    assert.ok(Object.isFrozen(state));
    assert.equal(state.kernel, kernel);
    assert.equal(state.limits, kernel.limits);
    assert.equal(state.sourceLength, expected.sourceLength);
    assert.equal(state.tokenCount, expected.tokenCount);
    assert.equal(
      state.delimiterScanWorkUnits,
      expected.delimiterScanWorkUnits,
    );
    assert.equal(state.kernel.sourceTokens, kernel.sourceTokens);
    assert.equal(state.kernel.tokens, kernel.tokens);
    assert.equal(state.kernel.statements, kernel.statements);
    assert.equal(state.kernel.delimiters, kernel.delimiters);
    assert.equal(
      state.kernel.delimiters.matchingIndexes,
      kernel.delimiters.matchingIndexes,
    );
  }
});

test("range-at returns frozen copies for tokens and global EOF", (): void => {
  const kernel = createSqlParserKernel(
    "first middle last  ",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const expectedRanges: ReadonlyArray<SqlSourceRange> = [
    { start: 0, end: 5 },
    { start: 6, end: 12 },
    { start: 13, end: 17 },
    { start: 19, end: 19 },
  ];

  for (let index = 0; index <= state.tokenCount; index++) {
    const range = sqlReadRangeAt(state, index);
    assert.deepEqual(range, expectedRanges[index]);
    assert.ok(Object.isFrozen(range));
    if (index < state.tokenCount) {
      assert.notEqual(range, kernel.tokens[index]?.range);
    }
  }
});

test("range-for-span handles non-empty and every empty boundary", (): void => {
  const kernel = createSqlParserKernel(
    "first middle last  ",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const cases: ReadonlyArray<Readonly<{
    startIndex: number;
    endIndex: number;
    range: SqlSourceRange;
  }>> = [
    { startIndex: 0, endIndex: 3, range: { start: 0, end: 17 } },
    { startIndex: 1, endIndex: 3, range: { start: 6, end: 17 } },
    { startIndex: 0, endIndex: 0, range: { start: 0, end: 0 } },
    { startIndex: 1, endIndex: 1, range: { start: 6, end: 6 } },
    { startIndex: 2, endIndex: 2, range: { start: 13, end: 13 } },
    { startIndex: 3, endIndex: 3, range: { start: 19, end: 19 } },
  ];

  for (const span of cases) {
    const range = sqlReadRangeForSpan(
      state,
      span.startIndex,
      span.endIndex,
    );
    assert.deepEqual(range, span.range);
    assert.ok(Object.isFrozen(range));
  }
});

test("range helpers reject invalid numeric indices without coercion", (): void => {
  const kernel = createSqlParserKernel(
    "a b c",
    limits(20, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const eofRange = { start: kernel.sql.length, end: kernel.sql.length };
  const invalidIndexes: ReadonlyArray<Readonly<{
    value: number;
    range: SqlSourceRange;
  }>> = [
    { value: Number.NaN, range: eofRange },
    { value: Number.NEGATIVE_INFINITY, range: eofRange },
    { value: Number.POSITIVE_INFINITY, range: eofRange },
    { value: -1, range: { start: 0, end: 0 } },
    { value: 0.5, range: eofRange },
    { value: Number.MAX_SAFE_INTEGER + 1, range: eofRange },
    { value: state.tokenCount + 1, range: eofRange },
  ];

  for (const invalid of invalidIndexes) {
    expectParserError(
      () => {
        sqlReadRangeAt(state, invalid.value);
      },
      "internal_invariant",
      invalid.range,
      /safe integer from 0 through 3/u,
    );
  }

  expectParserError(
    () => {
      sqlReadRangeForSpan(state, 2, 1);
    },
    "internal_invariant",
    { start: 4, end: 5 },
    /span start 2 exceeds end 1/u,
  );
  expectParserError(
    () => {
      sqlReadRangeForSpan(state, 0, Number.NaN);
    },
    "internal_invariant",
    eofRange,
    /SQL read span end/u,
  );
});

test("state creation rejects ordinary primitive and cross-field violations", (): void => {
  const kernel = createSqlParserKernel(
    "a b",
    limits(20, 10, 4, 20),
  );
  const eofRange = { start: kernel.sql.length, end: kernel.sql.length };
  const invalidWorkValues: ReadonlyArray<number> = [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const scanSteps of invalidWorkValues) {
    const invalidKernel: SqlParserKernel = {
      ...kernel,
      delimiters: { ...kernel.delimiters, scanSteps },
    };
    expectParserError(
      () => {
        createSqlReadState(invalidKernel);
      },
      "internal_invariant",
      eofRange,
      /delimiter scan work must be a non-negative safe integer/u,
    );
  }

  expectParserError(
    () => {
      createSqlReadState({
        ...kernel,
        delimiters: {
          ...kernel.delimiters,
          scanSteps: kernel.limits.maxWorkUnits + 1,
        },
      });
    },
    "internal_invariant",
    eofRange,
    /delimiter scan work 21 exceeds maxWorkUnits=20/u,
  );
  expectParserError(
    () => {
      createSqlReadState({
        ...kernel,
        limits: { ...kernel.limits, maxNestingDepth: 0 },
      });
    },
    "internal_invariant",
    { start: 0, end: 0 },
    /maxNestingDepth must be a positive safe integer/u,
  );
});

test("checked depth accepts the limit and reports the first excess range", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta",
    limits(20, 10, 2, 20),
  );
  const state = createSqlReadState(kernel);

  assert.equal(checkedSqlReadDepth(state, 0, 0, "Read cursor"), 0);
  assert.equal(checkedSqlReadDepth(state, 2, 1, "Read cursor"), 2);
  expectParserError(
    () => {
      checkedSqlReadDepth(state, 3, 1, "Read cursor");
    },
    "limit_nesting",
    { start: 6, end: 10 },
    /nesting depth 3 exceeds maxNestingDepth=2/u,
  );
  expectParserError(
    () => {
      checkedSqlReadDepth(state, 3, state.tokenCount, "Read cursor");
    },
    "limit_nesting",
    { start: kernel.sql.length, end: kernel.sql.length },
    /nesting depth 3 exceeds maxNestingDepth=2/u,
  );

  const invalidDepths: ReadonlyArray<number> = [
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  for (const depth of invalidDepths) {
    expectParserError(
      () => {
        checkedSqlReadDepth(state, depth, 0, "Read cursor");
      },
      "internal_invariant",
      { start: 0, end: 5 },
      /nesting depth must be a non-negative safe integer/u,
    );
  }
});

test("long flat state construction and far range lookup retain graph identity", {
  timeout: 3_000,
}, (): void => {
  const tokenCount = 20_000;
  const sql = Array.from(
    { length: tokenCount },
    (_value, index): string => `c${String(index)}`,
  ).join(" ");
  const kernel = createSqlParserKernel(
    sql,
    limits(sql.length, tokenCount, 4, tokenCount),
  );
  const state = createSqlReadState(kernel);

  assert.equal(state.kernel, kernel);
  assert.equal(state.kernel.tokens, kernel.tokens);
  assert.equal(state.kernel.delimiters, kernel.delimiters);
  assert.deepEqual(sqlReadRangeAt(state, tokenCount - 1), {
    start: sql.length - `c${String(tokenCount - 1)}`.length,
    end: sql.length,
  });
  assert.deepEqual(sqlReadRangeForSpan(state, tokenCount - 2, tokenCount), {
    start: sql.length
      - `c${String(tokenCount - 2)} c${String(tokenCount - 1)}`.length,
    end: sql.length,
  });
});
