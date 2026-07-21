import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  advanceSqlTokenCursor,
  consumeSqlTokenCursor,
  createSqlTokenCursor,
  inspectSqlTokenCursor,
  matchingSqlDelimiterIndexWithinCursor,
  restoreSqlTokenCursorPosition,
  sqlCursorRange,
  type SqlParserKernel,
  type SqlParserLimits,
  type SqlParserToken,
  type SqlTokenCursor,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";

export type SqlReadState = Readonly<{
  kernel: SqlParserKernel;
  limits: SqlParserLimits;
  sourceLength: number;
  tokenCount: number;
  delimiterScanWorkUnits: number;
}>;

export type SqlReadCursor = Readonly<{
  state: SqlReadState;
  index: number;
  endIndex: number;
  workUnits: number;
  depth: number;
}>;

export type SqlReadTokenInspection = Readonly<{
  cursor: SqlReadCursor;
  token: SqlParserToken | undefined;
}>;

export type SqlReadTokenConsumption = Readonly<{
  cursor: SqlReadCursor;
  token: SqlParserToken;
}>;

export type SqlReadDelimiterMatch = Readonly<{
  closeIndex: number;
  cursor: SqlReadCursor;
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

const checkedSqlReadStateKernel = (
  state: SqlReadState,
  subject: string,
): SqlParserKernel => {
  const kernel = state.kernel;
  const range = sqlReadRange(kernel.sql.length, kernel.sql.length);
  if (state.limits !== kernel.limits) {
    return sqlReadInvariant(
      `${subject} state limits must reference its parser kernel limits`,
      range,
    );
  }
  if (state.sourceLength !== kernel.sql.length) {
    return sqlReadInvariant(
      `${subject} state source length ${String(state.sourceLength)} does not match parser kernel source length ${String(kernel.sql.length)}`,
      range,
    );
  }
  if (state.tokenCount !== kernel.tokens.length) {
    return sqlReadInvariant(
      `${subject} state token count ${String(state.tokenCount)} does not match parser kernel token count ${String(kernel.tokens.length)}`,
      range,
    );
  }
  if (state.delimiterScanWorkUnits !== kernel.delimiters.scanSteps) {
    return sqlReadInvariant(
      `${subject} state delimiter scan work ${String(state.delimiterScanWorkUnits)} does not match parser kernel scanSteps=${String(kernel.delimiters.scanSteps)}`,
      range,
    );
  }
  return kernel;
};

const sqlReadCursor = (
  state: SqlReadState,
  index: number,
  endIndex: number,
  workUnits: number,
  depth: number,
): SqlReadCursor => Object.freeze({
  depth,
  endIndex,
  index,
  state,
  workUnits,
});

const checkedSqlReadDepthAtRange = (
  state: SqlReadState,
  depth: number,
  range: SqlSourceRange,
  subject: string,
): number => {
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
  return checkedSqlReadDepthAtRange(
    state,
    depth,
    rangeAtUnchecked(state, checkedIndex),
    subject,
  );
};

export const createSqlReadCursor = (
  state: SqlReadState,
  startIndex: number,
  endIndex: number,
): SqlReadCursor => {
  const kernel = checkedSqlReadStateKernel(state, "SQL read cursor creation");
  const cursor = createSqlTokenCursor(kernel, startIndex, endIndex);
  return sqlReadCursor(
    state,
    cursor.index,
    cursor.endIndex,
    cursor.workUnits,
    0,
  );
};

export const sqlTokenCursorFromReadCursor = (
  cursor: SqlReadCursor,
  operation: string,
): SqlTokenCursor => {
  const kernel = checkedSqlReadStateKernel(cursor.state, operation);
  const initial = createSqlTokenCursor(
    kernel,
    cursor.index,
    cursor.endIndex,
  );
  const restored = restoreSqlTokenCursorPosition(initial, {
    ...initial,
    workUnits: cursor.workUnits,
  });
  checkedSqlReadDepthAtRange(
    cursor.state,
    cursor.depth,
    sqlCursorRange(restored),
    operation,
  );
  return Object.freeze(restored);
};

export const adoptSqlTokenCursor = (
  cursor: SqlReadCursor,
  returned: SqlTokenCursor,
  operation: string,
): SqlReadCursor => {
  const parent = sqlTokenCursorFromReadCursor(cursor, operation);
  const range = sqlCursorRange(parent);
  if (returned.kernel !== parent.kernel) {
    return sqlReadInvariant(
      `${operation} returned a cursor for a different SQL parser kernel`,
      range,
    );
  }
  if (returned.endIndex !== parent.endIndex) {
    return sqlReadInvariant(
      `${operation} returned cursor end ${String(returned.endIndex)} but the read cursor end is ${String(parent.endIndex)}`,
      range,
    );
  }
  if (
    !Number.isSafeInteger(returned.index)
    || returned.index < parent.index
    || returned.index > parent.endIndex
  ) {
    return sqlReadInvariant(
      `${operation} returned cursor index ${String(returned.index)} outside the permitted read cursor range ${String(parent.index)}..${String(parent.endIndex)}`,
      range,
    );
  }
  checkedNonNegativeSafeInteger(
    returned.workUnits,
    `${operation} returned cursor workUnits`,
    range,
  );
  if (returned.workUnits < parent.workUnits) {
    return sqlReadInvariant(
      `${operation} returned cursor workUnits=${String(returned.workUnits)} would rewind read work from ${String(parent.workUnits)}`,
      range,
    );
  }
  const restored = restoreSqlTokenCursorPosition(parent, returned);
  return sqlReadCursor(
    cursor.state,
    returned.index,
    returned.endIndex,
    restored.workUnits,
    cursor.depth,
  );
};

export const inspectSqlReadToken = (
  cursor: SqlReadCursor,
  offset: number,
  operation: string,
): SqlReadTokenInspection => {
  const inspected = inspectSqlTokenCursor(
    sqlTokenCursorFromReadCursor(cursor, operation),
    offset,
    operation,
  );
  return Object.freeze({
    cursor: adoptSqlTokenCursor(cursor, inspected.cursor, operation),
    token: inspected.token,
  });
};

export const consumeSqlReadToken = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadTokenConsumption => {
  const consumed = consumeSqlTokenCursor(
    sqlTokenCursorFromReadCursor(cursor, operation),
    operation,
  );
  return Object.freeze({
    cursor: adoptSqlTokenCursor(cursor, consumed.cursor, operation),
    token: consumed.token,
  });
};

export const advanceSqlReadCursor = (
  cursor: SqlReadCursor,
  count: number,
  operation: string,
): SqlReadCursor => {
  const advanced = advanceSqlTokenCursor(
    sqlTokenCursorFromReadCursor(cursor, operation),
    count,
    operation,
  );
  return adoptSqlTokenCursor(cursor, advanced, operation);
};

export const narrowSqlReadCursor = (
  cursor: SqlReadCursor,
  endIndex: number,
  operation: string,
): SqlReadCursor => {
  const adapted = sqlTokenCursorFromReadCursor(cursor, operation);
  if (
    !Number.isSafeInteger(endIndex)
    || endIndex < cursor.index
    || endIndex > cursor.endIndex
  ) {
    return sqlReadInvariant(
      `${operation} bounded end ${String(endIndex)} must be a safe integer within the current read cursor range ${String(cursor.index)}..${String(cursor.endIndex)}`,
      sqlCursorRange(adapted),
    );
  }
  return sqlReadCursor(
    cursor.state,
    cursor.index,
    endIndex,
    cursor.workUnits,
    cursor.depth,
  );
};

export const resumeSqlReadCursor = (
  parent: SqlReadCursor,
  returned: SqlReadCursor,
  operation: string,
): SqlReadCursor => {
  const adaptedParent = sqlTokenCursorFromReadCursor(parent, operation);
  const range = sqlCursorRange(adaptedParent);
  if (returned.state !== parent.state) {
    return sqlReadInvariant(
      `${operation} returned a cursor for a different SQL read state`,
      range,
    );
  }
  if (
    !Number.isSafeInteger(returned.endIndex)
    || returned.endIndex < parent.index
    || returned.endIndex > parent.endIndex
  ) {
    return sqlReadInvariant(
      `${operation} returned cursor end ${String(returned.endIndex)} must be a safe integer within the parent read cursor range ${String(parent.index)}..${String(parent.endIndex)}`,
      range,
    );
  }
  if (
    !Number.isSafeInteger(returned.index)
    || returned.index < parent.index
    || returned.index > returned.endIndex
  ) {
    return sqlReadInvariant(
      `${operation} returned cursor index ${String(returned.index)} outside the permitted read cursor range ${String(parent.index)}..${String(returned.endIndex)}`,
      range,
    );
  }
  const adoptedWork = adoptSqlTokenCursor(
    parent,
    { ...adaptedParent, workUnits: returned.workUnits },
    operation,
  );
  const returnedDepth = checkedSqlReadDepthAtRange(
    parent.state,
    returned.depth,
    range,
    `${operation} returned cursor`,
  );
  if (returnedDepth < parent.depth) {
    return sqlReadInvariant(
      `${operation} returned cursor nesting depth ${String(returnedDepth)} would rewind the parent depth ${String(parent.depth)}`,
      range,
    );
  }

  return sqlReadCursor(
    parent.state,
    returned.index,
    parent.endIndex,
    adoptedWork.workUnits,
    parent.depth,
  );
};

export const enterSqlReadDepth = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadCursor => {
  const adapted = sqlTokenCursorFromReadCursor(cursor, operation);
  const depth = checkedSqlReadDepthAtRange(
    cursor.state,
    cursor.depth + 1,
    sqlCursorRange(adapted),
    operation,
  );
  return sqlReadCursor(
    cursor.state,
    cursor.index,
    cursor.endIndex,
    cursor.workUnits,
    depth,
  );
};

export const matchingSqlReadDelimiter = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadDelimiterMatch => {
  const inspected = inspectSqlTokenCursor(
    sqlTokenCursorFromReadCursor(cursor, operation),
    0,
    operation,
  );
  const closeIndex = matchingSqlDelimiterIndexWithinCursor(
    inspected.cursor,
    "unexpected_token",
    operation,
  );
  return Object.freeze({
    closeIndex,
    cursor: adoptSqlTokenCursor(cursor, inspected.cursor, operation),
  });
};
