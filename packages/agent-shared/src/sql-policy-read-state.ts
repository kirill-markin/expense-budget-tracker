import type { SqlSourceRange } from "./sql-policy-lexer.js";
import type {
  SqlParserKernel,
  SqlParserLimits,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";

export type SqlReadState = Readonly<{
  kernel: SqlParserKernel;
  limits: SqlParserLimits;
  sourceLength: number;
  tokenCount: number;
  delimiterScanWorkUnits: number;
}>;

const sqlReadRange = (start: number, end: number): SqlSourceRange =>
  Object.freeze({ start, end });

const sqlReadInvariant = (
  message: string,
  range: SqlSourceRange,
): never => throwSqlPolicyParserError("internal_invariant", message, range);

const checkedNonNegativeSafeInteger = (
  value: number,
  subject: string,
  range: SqlSourceRange,
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    return sqlReadInvariant(
      `${subject} must be a non-negative safe integer; received ${String(value)}`,
      range,
    );
  }
  return value;
};

const checkedPositiveSafeInteger = (
  value: number,
  subject: string,
): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return sqlReadInvariant(
      `${subject} must be a positive safe integer; received ${String(value)}`,
      sqlReadRange(0, 0),
    );
  }
  return value;
};

const rangeAtUnchecked = (
  state: SqlReadState,
  index: number,
): SqlSourceRange => {
  const range = state.kernel.tokens[index]?.range;
  return range === undefined
    ? sqlReadRange(state.sourceLength, state.sourceLength)
    : sqlReadRange(range.start, range.end);
};

const invalidIndexRange = (
  state: SqlReadState,
  index: number,
): SqlSourceRange => Number.isSafeInteger(index) && index < 0
  ? sqlReadRange(0, 0)
  : sqlReadRange(state.sourceLength, state.sourceLength);

const checkedBoundaryIndex = (
  state: SqlReadState,
  index: number,
  subject: string,
): number => {
  if (
    !Number.isSafeInteger(index)
    || index < 0
    || index > state.tokenCount
  ) {
    return sqlReadInvariant(
      `${subject} must be a safe integer from 0 through ${String(state.tokenCount)}; received ${String(index)}`,
      invalidIndexRange(state, index),
    );
  }
  return index;
};

export const createSqlReadState = (
  kernel: SqlParserKernel,
): SqlReadState => {
  const sourceLength = checkedNonNegativeSafeInteger(
    kernel.sql.length,
    "SQL read source length",
    sqlReadRange(0, 0),
  );
  const tokenCount = checkedNonNegativeSafeInteger(
    kernel.tokens.length,
    "SQL read token count",
    sqlReadRange(sourceLength, sourceLength),
  );
  checkedPositiveSafeInteger(
    kernel.limits.maxNestingDepth,
    "SQL read maxNestingDepth",
  );
  const maxWorkUnits = checkedPositiveSafeInteger(
    kernel.limits.maxWorkUnits,
    "SQL read maxWorkUnits",
  );
  const delimiterScanWorkUnits = checkedNonNegativeSafeInteger(
    kernel.delimiters.scanSteps,
    "SQL read delimiter scan work",
    sqlReadRange(sourceLength, sourceLength),
  );

  if (delimiterScanWorkUnits > maxWorkUnits) {
    return sqlReadInvariant(
      `SQL read delimiter scan work ${String(delimiterScanWorkUnits)} exceeds maxWorkUnits=${String(maxWorkUnits)}`,
      sqlReadRange(sourceLength, sourceLength),
    );
  }

  return Object.freeze({
    delimiterScanWorkUnits,
    kernel,
    limits: kernel.limits,
    sourceLength,
    tokenCount,
  });
};

export const sqlReadRangeAt = (
  state: SqlReadState,
  index: number,
): SqlSourceRange => rangeAtUnchecked(
  state,
  checkedBoundaryIndex(state, index, "SQL read range token index"),
);

export const sqlReadRangeForSpan = (
  state: SqlReadState,
  startIndex: number,
  endIndex: number,
): SqlSourceRange => {
  const checkedStart = checkedBoundaryIndex(
    state,
    startIndex,
    "SQL read span start",
  );
  const checkedEnd = checkedBoundaryIndex(
    state,
    endIndex,
    "SQL read span end",
  );
  if (checkedStart > checkedEnd) {
    return sqlReadInvariant(
      `SQL read span start ${String(checkedStart)} exceeds end ${String(checkedEnd)}`,
      rangeAtUnchecked(state, checkedStart),
    );
  }
  if (checkedStart === checkedEnd) {
    const boundary = rangeAtUnchecked(state, checkedStart);
    return sqlReadRange(boundary.start, boundary.start);
  }

  const first = state.kernel.tokens[checkedStart];
  const last = state.kernel.tokens[checkedEnd - 1];
  if (first === undefined || last === undefined) {
    return sqlReadInvariant(
      `SQL read span ${String(checkedStart)}..${String(checkedEnd)} lost its boundary tokens`,
      rangeAtUnchecked(state, checkedStart),
    );
  }
  return sqlReadRange(first.range.start, last.range.end);
};

export const checkedSqlReadDepth = (
  state: SqlReadState,
  depth: number,
  index: number,
  subject: string,
): number => {
  const checkedIndex = checkedBoundaryIndex(
    state,
    index,
    `${subject} depth position`,
  );
  const range = rangeAtUnchecked(state, checkedIndex);
  const checkedDepth = checkedNonNegativeSafeInteger(
    depth,
    `${subject} nesting depth`,
    range,
  );
  if (checkedDepth > state.limits.maxNestingDepth) {
    return throwSqlPolicyParserError(
      "limit_nesting",
      `${subject} nesting depth ${String(checkedDepth)} exceeds maxNestingDepth=${String(state.limits.maxNestingDepth)}`,
      range,
    );
  }
  return checkedDepth;
};
