import type { SqlSourceRange } from "./sql-policy-lexer.js";
import { postgreSqlTokenWord } from "./sql-policy-parser-keywords.js";
import { sqlCursorRange } from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";
import type {
  SqlExpressionEnvironment,
  SqlExpressionPrefixReader,
  SqlExpressionResult,
} from "./sql-policy-read-expression.js";
import {
  concatSqlExpressionMetadataSequences,
  emptySqlExpressionMetadataSequence,
  type SqlExpressionMetadataSequence,
} from "./sql-policy-read-metadata.js";
import {
  consumeSqlReadToken,
  enterSqlReadDepth,
  inspectSqlReadToken,
  resumeEnteredSqlReadCursor,
  resumeSqlReadCursor,
  sqlReadRangeForSpan,
  sqlTokenCursorFromReadCursor,
  type SqlReadCursor,
} from "./sql-policy-read-state.js";

type SqlWindowFrameBoundKind =
  | "current_row"
  | "offset_following"
  | "offset_preceding"
  | "unbounded_following"
  | "unbounded_preceding";

type SqlWindowFrameBoundRank = 0 | 1 | 2 | 3 | 4;

type SqlWindowFrameBound = Readonly<{
  cursor: SqlReadCursor;
  kind: SqlWindowFrameBoundKind;
  metadata: SqlExpressionMetadataSequence;
  range: SqlSourceRange;
  rank: SqlWindowFrameBoundRank;
}>;

type SqlWindowFrameSpecialBoundRead = Readonly<{
  bound: SqlWindowFrameBound | null;
  cursor: SqlReadCursor;
}>;

const readCursorRange = (
  cursor: SqlReadCursor,
  operation: string,
): SqlSourceRange => sqlCursorRange(
  sqlTokenCursorFromReadCursor(cursor, operation),
);

const unexpectedSqlReadToken = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "unexpected_token",
  message,
  readCursorRange(cursor, "Report SQL window-frame reader error"),
);

const sqlReadInvariant = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "internal_invariant",
  message,
  readCursorRange(cursor, "Report SQL window-frame reader invariant"),
);

const consumeRequiredWord = (
  cursor: SqlReadCursor,
  expected: string,
  message: string,
): SqlReadCursor => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    `Inspect window frame ${expected.toUpperCase()}`,
  );
  if (postgreSqlTokenWord(inspected.token) !== expected) {
    return unexpectedSqlReadToken(inspected.cursor, message);
  }
  return consumeSqlReadToken(
    inspected.cursor,
    `Consume window frame ${expected.toUpperCase()}`,
  ).cursor;
};

const windowFrameBound = (
  initial: SqlReadCursor,
  cursor: SqlReadCursor,
  metadata: SqlExpressionMetadataSequence,
  kind: SqlWindowFrameBoundKind,
  rank: SqlWindowFrameBoundRank,
): SqlWindowFrameBound => Object.freeze({
  cursor,
  kind,
  metadata,
  range: sqlReadRangeForSpan(initial.state, initial.index, cursor.index),
  rank,
});

const readSpecialWindowFrameBound = (
  cursor: SqlReadCursor,
): SqlWindowFrameSpecialBoundRead => {
  const initial = cursor;
  const first = inspectSqlReadToken(
    cursor,
    0,
    "Inspect special window frame bound",
  );
  const firstWord = postgreSqlTokenWord(first.token);
  if (firstWord !== "current" && firstWord !== "unbounded") {
    return Object.freeze({ bound: null, cursor: first.cursor });
  }

  const second = inspectSqlReadToken(
    first.cursor,
    1,
    "Inspect special window frame bound completion",
  );
  const secondWord = postgreSqlTokenWord(second.token);
  if (firstWord === "current" && secondWord === "row") {
    const afterFirst = consumeSqlReadToken(
      second.cursor,
      "Consume window frame CURRENT",
    ).cursor;
    const completed = consumeSqlReadToken(
      afterFirst,
      "Consume window frame CURRENT ROW",
    ).cursor;
    return Object.freeze({
      bound: windowFrameBound(
        initial,
        completed,
        emptySqlExpressionMetadataSequence(),
        "current_row",
        2,
      ),
      cursor: completed,
    });
  }
  if (
    firstWord === "unbounded"
    && (secondWord === "preceding" || secondWord === "following")
  ) {
    const afterFirst = consumeSqlReadToken(
      second.cursor,
      "Consume window frame UNBOUNDED",
    ).cursor;
    const completed = consumeSqlReadToken(
      afterFirst,
      "Consume window frame UNBOUNDED direction",
    ).cursor;
    return Object.freeze({
      bound: windowFrameBound(
        initial,
        completed,
        emptySqlExpressionMetadataSequence(),
        secondWord === "preceding"
          ? "unbounded_preceding"
          : "unbounded_following",
        secondWord === "preceding" ? 0 : 4,
      ),
      cursor: completed,
    });
  }
  return Object.freeze({ bound: null, cursor: second.cursor });
};

const readOffsetWindowFrameBound = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlWindowFrameBound => {
  const initial = cursor;
  const nested = enterSqlReadDepth(
    cursor,
    "Enter window frame offset expression",
  );
  const expression = readExpressionPrefix(environment, nested);
  const resumed = resumeEnteredSqlReadCursor(
    cursor,
    nested,
    expression.cursor,
    "Resume window frame offset expression",
  );
  if (resumed.index === initial.index) {
    return sqlReadInvariant(
      resumed,
      "Window frame offset prefix reader returned an empty expression",
    );
  }

  const direction = inspectSqlReadToken(
    resumed,
    0,
    "Inspect window frame offset direction",
  );
  const directionWord = postgreSqlTokenWord(direction.token);
  if (directionWord !== "preceding" && directionWord !== "following") {
    return unexpectedSqlReadToken(
      direction.cursor,
      "Window frame offset requires PRECEDING or FOLLOWING",
    );
  }
  const completed = consumeSqlReadToken(
    direction.cursor,
    "Consume window frame offset direction",
  ).cursor;
  return windowFrameBound(
    initial,
    completed,
    expression.metadata,
    directionWord === "preceding"
      ? "offset_preceding"
      : "offset_following",
    directionWord === "preceding" ? 1 : 3,
  );
};

const readWindowFrameBound = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlWindowFrameBound => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect PostgreSQL window frame bound",
  );
  if (inspected.token === undefined) {
    return unexpectedSqlReadToken(
      inspected.cursor,
      "Window frame requires a bound",
    );
  }
  const special = readSpecialWindowFrameBound(inspected.cursor);
  return special.bound ?? readOffsetWindowFrameBound(
    environment,
    special.cursor,
    readExpressionPrefix,
  );
};

const windowFrameBoundLabel = (kind: SqlWindowFrameBoundKind): string => {
  if (kind === "unbounded_preceding") {
    return "UNBOUNDED PRECEDING";
  }
  if (kind === "offset_preceding") {
    return "offset PRECEDING";
  }
  if (kind === "current_row") {
    return "CURRENT ROW";
  }
  if (kind === "offset_following") {
    return "offset FOLLOWING";
  }
  return "UNBOUNDED FOLLOWING";
};

const invalidWindowFrameBound = (
  bound: SqlWindowFrameBound,
  message: string,
): never => throwSqlPolicyParserError(
  "unexpected_token",
  message,
  bound.range,
);

const validateSingleWindowFrameStart = (
  start: SqlWindowFrameBound,
): void => {
  if (start.kind === "unbounded_following") {
    return invalidWindowFrameBound(
      start,
      "Window frame start cannot be UNBOUNDED FOLLOWING",
    );
  }
  if (start.rank > 2) {
    return invalidWindowFrameBound(
      start,
      `Window frame start ${windowFrameBoundLabel(start.kind)} cannot be later than the implicit CURRENT ROW end`,
    );
  }
};

const validateBetweenWindowFrameBounds = (
  start: SqlWindowFrameBound,
  end: SqlWindowFrameBound,
): void => {
  if (start.kind === "unbounded_following") {
    return invalidWindowFrameBound(
      start,
      "Window frame start cannot be UNBOUNDED FOLLOWING",
    );
  }
  if (end.kind === "unbounded_preceding") {
    return invalidWindowFrameBound(
      end,
      "Window frame end cannot be UNBOUNDED PRECEDING",
    );
  }
  if (start.rank > end.rank) {
    return invalidWindowFrameBound(
      end,
      `Window frame end ${windowFrameBoundLabel(end.kind)} cannot precede frame start ${windowFrameBoundLabel(start.kind)}`,
    );
  }
};

const readWindowFrameExclusion = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect window frame EXCLUDE option",
  );
  const word = postgreSqlTokenWord(inspected.token);
  if (word === "current") {
    const afterCurrent = consumeSqlReadToken(
      inspected.cursor,
      "Consume window frame EXCLUDE CURRENT",
    ).cursor;
    return consumeRequiredWord(
      afterCurrent,
      "row",
      "Window frame EXCLUDE CURRENT requires ROW",
    );
  }
  if (word === "group" || word === "ties") {
    return consumeSqlReadToken(
      inspected.cursor,
      "Consume window frame EXCLUDE option",
    ).cursor;
  }
  if (word === "no") {
    const afterNo = consumeSqlReadToken(
      inspected.cursor,
      "Consume window frame EXCLUDE NO",
    ).cursor;
    return consumeRequiredWord(
      afterNo,
      "others",
      "Window frame EXCLUDE NO requires OTHERS",
    );
  }
  return unexpectedSqlReadToken(
    inspected.cursor,
    "Window frame EXCLUDE requires CURRENT ROW, GROUP, TIES, or NO OTHERS",
  );
};

const consumeWindowFrameMode = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  const inspected = inspectSqlReadToken(
    cursor,
    0,
    "Inspect PostgreSQL window frame mode",
  );
  const word = postgreSqlTokenWord(inspected.token);
  if (word !== "groups" && word !== "range" && word !== "rows") {
    return unexpectedSqlReadToken(
      inspected.cursor,
      "Window frame requires RANGE, ROWS, or GROUPS",
    );
  }
  return consumeSqlReadToken(
    inspected.cursor,
    "Consume PostgreSQL window frame mode",
  ).cursor;
};

/** Reads one complete frame clause from an exact parent-bounded cursor. */
export const readSqlWindowFrame = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlExpressionResult => {
  const initial = cursor;
  let current = consumeWindowFrameMode(cursor);
  const form = inspectSqlReadToken(
    current,
    0,
    "Inspect PostgreSQL window frame form",
  );
  current = form.cursor;

  let start: SqlWindowFrameBound;
  let end: SqlWindowFrameBound | null = null;
  if (postgreSqlTokenWord(form.token) === "between") {
    current = consumeSqlReadToken(
      current,
      "Consume window frame BETWEEN",
    ).cursor;
    start = readWindowFrameBound(
      environment,
      current,
      readExpressionPrefix,
    );
    current = consumeRequiredWord(
      start.cursor,
      "and",
      "Window frame BETWEEN requires AND",
    );
    end = readWindowFrameBound(
      environment,
      current,
      readExpressionPrefix,
    );
    current = end.cursor;
  } else {
    start = readWindowFrameBound(
      environment,
      current,
      readExpressionPrefix,
    );
    current = start.cursor;
  }

  const exclusion = inspectSqlReadToken(
    current,
    0,
    "Inspect window frame EXCLUDE clause",
  );
  current = exclusion.cursor;
  if (postgreSqlTokenWord(exclusion.token) === "exclude") {
    current = consumeSqlReadToken(
      current,
      "Consume window frame EXCLUDE",
    ).cursor;
    current = readWindowFrameExclusion(current);
  }

  const trailing = inspectSqlReadToken(
    current,
    0,
    "Inspect token after window frame clause",
  );
  current = trailing.cursor;
  if (trailing.token !== undefined) {
    if (postgreSqlTokenWord(trailing.token) === "exclude") {
      return unexpectedSqlReadToken(
        current,
        "Window frame cannot contain more than one EXCLUDE clause",
      );
    }
    return unexpectedSqlReadToken(
      current,
      "Unexpected token after the window frame clause",
    );
  }

  if (end === null) {
    validateSingleWindowFrameStart(start);
  } else {
    validateBetweenWindowFrameBounds(start, end);
  }

  return Object.freeze({
    cursor: current,
    metadata: end === null
      ? concatSqlExpressionMetadataSequences(
        start.metadata,
        emptySqlExpressionMetadataSequence(),
      )
      : concatSqlExpressionMetadataSequences(start.metadata, end.metadata),
    range: sqlReadRangeForSpan(initial.state, initial.index, current.index),
  });
};
