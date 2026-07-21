import assert from "node:assert/strict";
import test from "node:test";
import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  advanceSqlTokenCursor,
  consumeSqlTokenCursor,
  createSqlParserKernel,
  restoreSqlTokenCursorPosition,
  type SqlParserKernel,
  type SqlParserLimits,
  type SqlTokenCursor,
} from "./sql-policy-parser-kernel.js";
import {
  SqlPolicyParserError,
  type SqlPolicyParserErrorCode,
} from "./sql-policy-parser-model.js";
import {
  adoptSqlTokenCursor,
  advanceSqlReadCursor,
  checkedSqlReadDepth,
  consumeSqlReadToken,
  createSqlReadCursor,
  createSqlReadState,
  enterSqlReadDepth,
  inspectSqlReadToken,
  matchingSqlReadDelimiter,
  narrowSqlReadCursor,
  sqlReadRangeAt,
  sqlReadRangeForSpan,
  sqlTokenCursorFromReadCursor,
} from "./sql-policy-read-state.js";
import { parsePostgreSqlTypedConstantAtCursor } from "./sql-policy-type-parser.js";

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

test("read cursor creation is frozen, bounded, and starts at delimiter work", (): void => {
  const emptyState = createSqlReadState(
    createSqlParserKernel("", limits(10, 10, 4, 10)),
  );
  const empty = createSqlReadCursor(emptyState, 0, 0);
  assert.ok(Object.isFrozen(empty));
  assert.deepEqual(empty, {
    depth: 0,
    endIndex: 0,
    index: 0,
    state: emptyState,
    workUnits: 0,
  });

  const kernel = createSqlParserKernel(
    "alpha beta gamma",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const bounded = createSqlReadCursor(state, 1, 2);
  assert.ok(Object.isFrozen(bounded));
  assert.equal(bounded.state, state);
  assert.equal(bounded.index, 1);
  assert.equal(bounded.endIndex, 2);
  assert.equal(bounded.workUnits, state.delimiterScanWorkUnits);
  assert.equal(bounded.depth, 0);

  expectParserError(
    () => {
      createSqlReadCursor(state, 2, 1);
    },
    "internal_invariant",
    { start: 11, end: 16 },
    /Invalid SQL token cursor bounds 2\.\.1 for 3 tokens/u,
  );
  expectParserError(
    () => {
      createSqlReadCursor(state, 0, state.tokenCount + 1);
    },
    "internal_invariant",
    { start: 0, end: 5 },
    /Invalid SQL token cursor bounds 0\.\.4 for 3 tokens/u,
  );
});

test("read inspection, consumption, and advancement preserve exact transitions", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta trailing",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const initial = createSqlReadCursor(state, 0, 2);
  const inspected = inspectSqlReadToken(
    initial,
    1,
    "Inspect bounded beta",
  );
  assert.ok(Object.isFrozen(inspected));
  assert.ok(Object.isFrozen(inspected.cursor));
  assert.equal(inspected.token, kernel.tokens[1]);
  assert.deepEqual(inspected.token?.range, { start: 6, end: 10 });
  assert.equal(inspected.cursor.index, 0);
  assert.equal(inspected.cursor.endIndex, 2);
  assert.equal(inspected.cursor.workUnits, initial.workUnits + 1);

  const consumed = consumeSqlReadToken(
    inspected.cursor,
    "Consume bounded alpha",
  );
  assert.ok(Object.isFrozen(consumed));
  assert.equal(consumed.token, kernel.tokens[0]);
  assert.equal(consumed.cursor.index, 1);
  assert.equal(
    consumed.cursor.workUnits,
    inspected.cursor.workUnits + 1,
  );

  const exhausted = advanceSqlReadCursor(
    consumed.cursor,
    1,
    "Advance to bounded EOF",
  );
  assert.equal(exhausted.index, 2);
  assert.equal(exhausted.endIndex, 2);
  assert.equal(exhausted.workUnits, consumed.cursor.workUnits + 1);
  const eof = inspectSqlReadToken(exhausted, 0, "Inspect bounded EOF");
  assert.equal(eof.token, undefined);
  assert.equal(eof.cursor.index, 2);
  assert.equal(eof.cursor.workUnits, exhausted.workUnits + 1);
  expectParserError(
    () => {
      consumeSqlReadToken(eof.cursor, "Consume bounded EOF");
    },
    "internal_invariant",
    { start: 10, end: 10 },
    /bounded end 2/u,
  );

  assert.equal(initial.index, 0);
  assert.equal(initial.workUnits, kernel.delimiters.scanSteps);
});

test("read work permits the exact maximum and fails on the first excess", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta gamma",
    limits(30, 10, 4, 5),
  );
  const state = createSqlReadState(kernel);
  const initial = createSqlReadCursor(state, 0, state.tokenCount);
  const exact = advanceSqlReadCursor(
    initial,
    2,
    "Advance at exact work limit",
  );
  assert.equal(exact.index, 2);
  assert.equal(exact.workUnits, kernel.limits.maxWorkUnits);
  expectParserError(
    () => {
      consumeSqlReadToken(exact, "Consume first excess");
    },
    "limit_complexity",
    { start: 11, end: 16 },
    /maxWorkUnits=5 at token 2/u,
  );
  expectParserError(
    () => {
      advanceSqlReadCursor(initial, 3, "Advance through first excess");
    },
    "limit_complexity",
    { start: 11, end: 16 },
    /maxWorkUnits=5 at token 2/u,
  );

  const emptyKernel = createSqlParserKernel(
    "alpha beta",
    limits(20, 10, 4, 2),
  );
  const emptyAtLimit = createSqlReadCursor(
    createSqlReadState(emptyKernel),
    0,
    0,
  );
  expectParserError(
    () => {
      inspectSqlReadToken(emptyAtLimit, 0, "Inspect exhausted empty range");
    },
    "limit_complexity",
    { start: 0, end: 0 },
    /maxWorkUnits=2 at token 0/u,
  );
});

test("narrowing preserves cumulative work and exact bounded EOF", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta gamma",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const advanced = advanceSqlReadCursor(
    createSqlReadCursor(state, 0, state.tokenCount),
    1,
    "Prepare bounded cursor",
  );
  const bounded = narrowSqlReadCursor(advanced, 2, "Narrow read cursor");
  assert.ok(Object.isFrozen(bounded));
  assert.equal(bounded.index, 1);
  assert.equal(bounded.endIndex, 2);
  assert.equal(bounded.workUnits, advanced.workUnits);
  const atEnd = advanceSqlReadCursor(bounded, 1, "Reach bounded end");
  const inspected = inspectSqlReadToken(atEnd, 0, "Inspect narrowed EOF");
  assert.equal(inspected.token, undefined);

  expectParserError(
    () => {
      consumeSqlReadToken(inspected.cursor, "Consume narrowed EOF");
    },
    "internal_invariant",
    { start: 10, end: 10 },
    /bounded end 2/u,
  );
  expectParserError(
    () => {
      narrowSqlReadCursor(advanced, 0, "Narrow before current index");
    },
    "internal_invariant",
    { start: 6, end: 10 },
    /safe integer within the current read cursor range 1\.\.3/u,
  );
  expectParserError(
    () => {
      narrowSqlReadCursor(advanced, Number.NaN, "Narrow with invalid end");
    },
    "internal_invariant",
    { start: 6, end: 10 },
    /bounded end NaN must be a safe integer/u,
  );
  expectParserError(
    () => {
      narrowSqlReadCursor(advanced, 4, "Narrow past current end");
    },
    "internal_invariant",
    { start: 6, end: 10 },
    /current read cursor range 1\.\.3/u,
  );
});

test("read depth accepts the maximum at token and bounded EOF positions", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta",
    limits(20, 10, 2, 20),
  );
  const state = createSqlReadState(kernel);
  const atToken = advanceSqlReadCursor(
    createSqlReadCursor(state, 0, state.tokenCount),
    1,
    "Reach depth token",
  );
  const tokenDepthOne = enterSqlReadDepth(atToken, "Token depth");
  const tokenDepthMax = enterSqlReadDepth(tokenDepthOne, "Token depth");
  assert.equal(tokenDepthMax.depth, state.limits.maxNestingDepth);
  assert.equal(tokenDepthMax.workUnits, atToken.workUnits);
  expectParserError(
    () => {
      enterSqlReadDepth(tokenDepthMax, "Token depth");
    },
    "limit_nesting",
    { start: 6, end: 10 },
    /nesting depth 3 exceeds maxNestingDepth=2/u,
  );

  const boundedEnd = advanceSqlReadCursor(
    createSqlReadCursor(state, 0, 1),
    1,
    "Reach bounded depth EOF",
  );
  const eofDepthOne = enterSqlReadDepth(boundedEnd, "Bounded EOF depth");
  const eofDepthMax = enterSqlReadDepth(eofDepthOne, "Bounded EOF depth");
  assert.equal(eofDepthMax.depth, state.limits.maxNestingDepth);
  assert.equal(eofDepthMax.workUnits, boundedEnd.workUnits);
  expectParserError(
    () => {
      enterSqlReadDepth(eofDepthMax, "Bounded EOF depth");
    },
    "limit_nesting",
    { start: 5, end: 5 },
    /nesting depth 3 exceeds maxNestingDepth=2/u,
  );
});

test("delimiter matching is bounded, opening-only, and charged once", (): void => {
  const kernel = createSqlParserKernel(
    "(alpha) trailing",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const cursor = createSqlReadCursor(state, 0, 3);
  const matched = matchingSqlReadDelimiter(cursor, "Match read delimiter");
  assert.ok(Object.isFrozen(matched));
  assert.equal(matched.closeIndex, 2);
  assert.equal(matched.cursor.index, cursor.index);
  assert.equal(matched.cursor.endIndex, cursor.endIndex);
  assert.equal(matched.cursor.workUnits, cursor.workUnits + 1);

  const notOpening = advanceSqlReadCursor(
    cursor,
    1,
    "Reach non-opening token",
  );
  expectParserError(
    () => {
      matchingSqlReadDelimiter(notOpening, "Reject non-opening token");
    },
    "internal_invariant",
    { start: 1, end: 6 },
    /not an indexed opening SQL delimiter/u,
  );
  const excludesClose = narrowSqlReadCursor(
    cursor,
    2,
    "Exclude closing delimiter",
  );
  expectParserError(
    () => {
      matchingSqlReadDelimiter(excludesClose, "Reject out-of-range close");
    },
    "unexpected_token",
    { start: 0, end: 1 },
    /closes outside the current parse range/u,
  );
});

test("token cursor adapters round-trip typed-constant results without rewinding work", (): void => {
  const kernel = createSqlParserKernel(
    "date '2024-01-01' trailing",
    limits(40, 10, 4, 40),
  );
  const state = createSqlReadState(kernel);
  const initial = enterSqlReadDepth(
    createSqlReadCursor(state, 0, 2),
    "Typed-constant read depth",
  );
  const delegated = sqlTokenCursorFromReadCursor(
    initial,
    "Adapt typed-constant cursor",
  );
  assert.ok(Object.isFrozen(delegated));
  assert.equal(delegated.kernel, kernel);
  assert.equal(delegated.index, initial.index);
  assert.equal(delegated.endIndex, initial.endIndex);
  assert.equal(delegated.workUnits, initial.workUnits);
  const roundTrip = adoptSqlTokenCursor(
    initial,
    delegated,
    "Round-trip typed-constant cursor",
  );
  assert.equal(roundTrip.index, initial.index);
  assert.equal(roundTrip.workUnits, initial.workUnits);
  assert.equal(roundTrip.depth, initial.depth);

  const parsed = parsePostgreSqlTypedConstantAtCursor(delegated);
  assert.equal(parsed.matched, true);
  if (!parsed.matched) {
    assert.fail("Expected a date typed constant");
  }
  const adopted = adoptSqlTokenCursor(
    initial,
    parsed.cursor,
    "Adopt typed-constant cursor",
  );
  assert.equal(adopted.index, 2);
  assert.equal(adopted.endIndex, initial.endIndex);
  assert.equal(adopted.workUnits, parsed.cursor.workUnits);
  assert.ok(adopted.workUnits > initial.workUnits);
  assert.equal(adopted.depth, initial.depth);
});

test("cursor adoption rejects kernel, end, work, and read-bound violations", (): void => {
  const kernel = createSqlParserKernel(
    "alpha beta gamma",
    limits(30, 10, 4, 20),
  );
  const otherKernel = createSqlParserKernel(
    "other value here",
    limits(30, 10, 4, 20),
  );
  const state = createSqlReadState(kernel);
  const parent = advanceSqlReadCursor(
    createSqlReadCursor(state, 0, state.tokenCount),
    1,
    "Prepare adoption parent",
  );
  const delegated = sqlTokenCursorFromReadCursor(parent, "Prepare adoption");
  const cases: ReadonlyArray<Readonly<{
    cursor: SqlTokenCursor;
    message: RegExp;
  }>> = [
    {
      cursor: { ...delegated, kernel: otherKernel },
      message: /different SQL parser kernel/u,
    },
    {
      cursor: { ...delegated, endIndex: delegated.endIndex - 1 },
      message: /returned cursor end 2 but the read cursor end is 3/u,
    },
    {
      cursor: { ...delegated, index: parent.index - 1 },
      message: /outside the permitted read cursor range 1\.\.3/u,
    },
    {
      cursor: { ...delegated, index: parent.endIndex + 1 },
      message: /outside the permitted read cursor range 1\.\.3/u,
    },
    {
      cursor: { ...delegated, workUnits: parent.workUnits - 1 },
      message: /would rewind read work/u,
    },
    {
      cursor: { ...delegated, workUnits: Number.NaN },
      message: /workUnits must be a non-negative safe integer/u,
    },
    {
      cursor: {
        ...delegated,
        workUnits: kernel.limits.maxWorkUnits + 1,
      },
      message: /exceeds maxWorkUnits=20/u,
    },
  ];

  for (const invalid of cases) {
    expectParserError(
      () => {
        adoptSqlTokenCursor(parent, invalid.cursor, "Reject returned cursor");
      },
      "internal_invariant",
      { start: 6, end: 10 },
      invalid.message,
    );
  }
});

test("restored delegated attempts cannot reset the read work budget", (): void => {
  const kernel = createSqlParserKernel(
    "only",
    limits(10, 10, 4, 3),
  );
  const state = createSqlReadState(kernel);
  let cursor = createSqlReadCursor(state, 0, state.tokenCount);

  for (let attempt = 0; attempt < 2; attempt++) {
    const delegated = sqlTokenCursorFromReadCursor(
      cursor,
      `Delegate attempt ${String(attempt + 1)}`,
    );
    const consumed = consumeSqlTokenCursor(
      delegated,
      `Consume attempt ${String(attempt + 1)}`,
    );
    const restored = restoreSqlTokenCursorPosition(
      delegated,
      consumed.cursor,
    );
    cursor = adoptSqlTokenCursor(
      cursor,
      restored,
      `Adopt attempt ${String(attempt + 1)}`,
    );
    assert.equal(cursor.index, 0);
    assert.equal(
      cursor.workUnits,
      kernel.delimiters.scanSteps + attempt + 1,
    );
  }

  expectParserError(
    () => {
      consumeSqlReadToken(cursor, "Consume after exhausted attempts");
    },
    "limit_complexity",
    { start: 0, end: 4 },
    /maxWorkUnits=3 at token 0/u,
  );
});

test("read cursors retain linear work on long flat and delimiter inputs", {
  timeout: 3_000,
}, (): void => {
  const flatTokenCount = 20_000;
  const flatSql = Array.from(
    { length: flatTokenCount },
    (_value, index): string => `c${String(index)}`,
  ).join(" ");
  const flatKernel = createSqlParserKernel(
    flatSql,
    limits(
      flatSql.length,
      flatTokenCount,
      4,
      flatTokenCount * 2 + 1,
    ),
  );
  const flatState = createSqlReadState(flatKernel);
  const inspected = inspectSqlReadToken(
    createSqlReadCursor(flatState, 0, flatState.tokenCount),
    flatTokenCount - 1,
    "Inspect last flat token",
  );
  assert.equal(inspected.token?.text, `c${String(flatTokenCount - 1)}`);
  const traversed = advanceSqlReadCursor(
    inspected.cursor,
    flatTokenCount,
    "Traverse flat tokens",
  );
  assert.equal(traversed.index, flatTokenCount);
  assert.equal(traversed.workUnits, flatKernel.limits.maxWorkUnits);

  const pairCount = 5_000;
  const delimiterSql = "()".repeat(pairCount);
  const delimiterKernel = createSqlParserKernel(
    delimiterSql,
    limits(
      delimiterSql.length,
      delimiterSql.length,
      4,
      delimiterSql.length + pairCount * 3,
    ),
  );
  const delimiterState = createSqlReadState(delimiterKernel);
  let delimiterCursor = createSqlReadCursor(
    delimiterState,
    0,
    delimiterState.tokenCount,
  );
  for (let pair = 0; pair < pairCount; pair++) {
    const matched = matchingSqlReadDelimiter(
      delimiterCursor,
      "Match flat delimiter",
    );
    assert.equal(matched.closeIndex, delimiterCursor.index + 1);
    delimiterCursor = advanceSqlReadCursor(
      matched.cursor,
      2,
      "Advance flat delimiter pair",
    );
  }
  assert.equal(delimiterCursor.index, delimiterState.tokenCount);
  assert.equal(
    delimiterCursor.workUnits,
    delimiterKernel.limits.maxWorkUnits,
  );
});
