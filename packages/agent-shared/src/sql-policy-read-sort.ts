import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  isPostgreSqlColId,
  postgreSqlTokenWord,
} from "./sql-policy-parser-keywords.js";
import {
  restoreSqlTokenCursorPosition,
  sqlCursorRange,
  type SqlParserToken,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";
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
import {
  adoptSqlTokenCursor,
  advanceSqlReadCursor,
  consumeSqlReadToken,
  enterSqlReadDepth,
  inspectSqlReadToken,
  matchingSqlReadDelimiter,
  narrowSqlReadCursor,
  resumeSqlReadCursor,
  sqlReadRangeForSpan,
  sqlTokenCursorFromReadCursor,
  type SqlReadCursor,
} from "./sql-policy-read-state.js";

type SqlMetadataAccumulator = {
  calls: Array<SqlCallNode>;
  nestedQueries: Array<SqlNestedQueryNode>;
  typeConstructs: Array<SqlTypeConstructNode>;
};

type SqlReadProbe = Readonly<{
  cursor: SqlReadCursor;
  token: SqlParserToken | undefined;
}>;

type SqlSortExpressionRead = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadata;
}>;

const metadataAccumulator = (): SqlMetadataAccumulator => ({
  calls: [],
  nestedQueries: [],
  typeConstructs: [],
});

const appendExpressionMetadata = (
  target: SqlMetadataAccumulator,
  metadata: SqlExpressionMetadata,
): void => {
  for (const call of metadata.calls) {
    target.calls.push(call);
  }
  for (const nestedQuery of metadata.nestedQueries) {
    target.nestedQueries.push(nestedQuery);
  }
  for (const typeConstruct of metadata.typeConstructs) {
    target.typeConstructs.push(typeConstruct);
  }
};

const expressionMetadata = (
  accumulator: SqlMetadataAccumulator,
): SqlExpressionMetadata => Object.freeze({
  calls: Object.freeze(accumulator.calls),
  nestedQueries: Object.freeze(accumulator.nestedQueries),
  typeConstructs: Object.freeze(accumulator.typeConstructs),
});

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
  readCursorRange(cursor, "Report SQL sort-reader error"),
);

const sqlReadInvariant = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "internal_invariant",
  message,
  readCursorRange(cursor, "Report SQL sort-reader invariant"),
);

const inspectCurrentSqlReadToken = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadProbe => inspectSqlReadToken(cursor, 0, operation);

const restoreSqlReadPosition = (
  original: SqlReadCursor,
  attempted: SqlReadCursor,
  operation: string,
): SqlReadCursor => adoptSqlTokenCursor(
  original,
  restoreSqlTokenCursorPosition(
    sqlTokenCursorFromReadCursor(original, `${operation} original cursor`),
    sqlTokenCursorFromReadCursor(attempted, `${operation} attempted cursor`),
  ),
  operation,
);

const skipNestedSqlReadDelimiter = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadCursor => {
  const nested = enterSqlReadDepth(cursor, `${operation} nesting`);
  const matched = matchingSqlReadDelimiter(
    nested,
    `${operation} delimiter lookup`,
  );
  const advanced = advanceSqlReadCursor(
    matched.cursor,
    matched.closeIndex - cursor.index + 1,
    `${operation} delimiter traversal`,
  );
  return resumeSqlReadCursor(
    cursor,
    advanced,
    `${operation} delimiter resumption`,
  );
};

const isOpeningDelimiter = (token: SqlParserToken): boolean =>
  token.text === "(" || token.text === "[";

const canPrecedeSortSuffix = (token: SqlParserToken): boolean =>
  token.kind === "identifier"
  || token.kind === "numeric"
  || token.kind === "parameter"
  || token.kind === "string"
  || token.text === ")"
  || token.text === "]";

const isPostgreSqlAllOperator = (token: SqlParserToken): boolean =>
  token.kind === "operator"
  && token.text !== "::"
  && token.text !== ":="
  && token.text !== ".."
  && token.text !== "=>";

const isSortDirectionWord = (word: string | null): boolean =>
  word === "asc"
  || word === "desc"
  || word === "using";

const isSortSuffixWord = (word: string | null): boolean =>
  word === "nulls" || isSortDirectionWord(word);

const inspectNextWord = (
  cursor: SqlReadCursor,
  operation: string,
): Readonly<{ cursor: SqlReadCursor; word: string | null }> => {
  const inspected = inspectSqlReadToken(cursor, 1, operation);
  return Object.freeze({
    cursor: inspected.cursor,
    word: postgreSqlTokenWord(inspected.token),
  });
};

const scanSortExpressionEnd = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = cursor;
  let canCompleteFieldWildcard: boolean = false;
  let canPrecedeSuffix: boolean = false;
  while (true) {
    const inspected = inspectCurrentSqlReadToken(
      current,
      "Scan ORDER BY expression",
    );
    current = inspected.cursor;
    if (inspected.token === undefined || inspected.token.text === ",") {
      return current;
    }
    if (isOpeningDelimiter(inspected.token)) {
      current = skipNestedSqlReadDelimiter(
        current,
        "Scan ORDER BY expression",
      );
      canCompleteFieldWildcard = false;
      canPrecedeSuffix = true;
      continue;
    }
    const word = postgreSqlTokenWord(inspected.token);
    if (
      canPrecedeSuffix
      && (word === "asc" || word === "desc")
    ) {
      return current;
    }
    if (canPrecedeSuffix && word === "using") {
      const operator = inspectSqlReadToken(
        current,
        1,
        "Inspect contextual ORDER BY USING operator",
      );
      current = operator.cursor;
      if (
        operator.token?.kind === "operator"
        || postgreSqlTokenWord(operator.token) === "operator"
      ) {
        return current;
      }
    }
    if (word === "nulls") {
      const next = inspectNextWord(
        current,
        "Inspect contextual ORDER BY NULLS suffix",
      );
      current = next.cursor;
      if (next.word === "first" || next.word === "last") {
        return current;
      }
    }
    const isFieldWildcard: boolean = canCompleteFieldWildcard
      && inspected.token.kind === "operator"
      && inspected.token.text === "*";
    canCompleteFieldWildcard = inspected.token.text === "."
      && canPrecedeSuffix;
    canPrecedeSuffix = isFieldWildcard
      || canPrecedeSortSuffix(inspected.token);
    current = advanceSqlReadCursor(
      current,
      1,
      "Advance ORDER BY expression scan",
    );
  }
};

const readExactSqlExpression = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  endIndex: number,
  reader: SqlExpressionReader<SqlExpressionResult>,
  subject: string,
): SqlSortExpressionRead => {
  const bounded = narrowSqlReadCursor(
    cursor,
    endIndex,
    `Bound ${subject}`,
  );
  const nested = enterSqlReadDepth(bounded, `Enter ${subject}`);
  const result = reader(environment, nested);
  const completedChild = resumeSqlReadCursor(
    nested,
    result.cursor,
    `Resume ${subject} result`,
  );
  if (
    completedChild.index !== endIndex
    || completedChild.endIndex !== endIndex
  ) {
    return sqlReadInvariant(
      completedChild,
      `${subject} reader returned cursor ${String(completedChild.index)}..${String(completedChild.endIndex)} but the exact expression span ends at token ${String(endIndex)}`,
    );
  }
  return Object.freeze({
    cursor: resumeSqlReadCursor(
      cursor,
      completedChild,
      `Resume exact ${subject}`,
    ),
    metadata: result.metadata,
  });
};

const readPrefixSqlExpression = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  reader: SqlExpressionPrefixReader,
): SqlSortExpressionRead => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter ORDER BY expression prefix",
  );
  const result = reader(environment, nested);
  const resumed = resumeSqlReadCursor(
    cursor,
    result.cursor,
    "Resume ORDER BY expression prefix",
  );
  if (resumed.index === cursor.index) {
    return sqlReadInvariant(
      resumed,
      "ORDER BY expression prefix reader returned an empty expression",
    );
  }
  return Object.freeze({
    cursor: resumed,
    metadata: result.metadata,
  });
};

const expressionResult = (
  initial: SqlReadCursor,
  cursor: SqlReadCursor,
  metadata: SqlMetadataAccumulator,
): SqlExpressionResult => Object.freeze({
  cursor,
  metadata: expressionMetadata(metadata),
  range: sqlReadRangeForSpan(
    initial.state,
    initial.index,
    cursor.index,
  ),
});

const emptySortExpressionMessage = (
  cursor: SqlReadCursor,
  token: SqlParserToken | undefined,
  itemCount: number,
): never => {
  if (token === undefined && itemCount === 0) {
    return unexpectedSqlReadToken(
      cursor,
      "ORDER BY requires at least one expression",
    );
  }
  if (token?.text === ",") {
    return unexpectedSqlReadToken(
      cursor,
      "ORDER BY item requires an expression before comma",
    );
  }
  const word = postgreSqlTokenWord(token);
  return unexpectedSqlReadToken(
    cursor,
    `ORDER BY item requires an expression before ${word?.toUpperCase() ?? "the item suffix"}`,
  );
};

const malformedSortSuffix = (
  cursor: SqlReadCursor,
  word: string,
  direction: "keyword" | "using" | null,
  hasNulls: boolean,
): never => {
  if (word === "nulls") {
    return unexpectedSqlReadToken(
      cursor,
      "ORDER BY item cannot contain more than one NULLS clause",
    );
  }
  if (hasNulls) {
    return unexpectedSqlReadToken(
      cursor,
      `${word.toUpperCase()} must appear before NULLS ordering in an ORDER BY item`,
    );
  }
  if (direction !== null) {
    return unexpectedSqlReadToken(
      cursor,
      "ORDER BY item cannot contain more than one ASC, DESC, or USING clause",
    );
  }
  return unexpectedSqlReadToken(
    cursor,
    "Malformed ORDER BY item suffix",
  );
};

const readQualifiedSortOperator = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  let current = consumeSqlReadToken(
    cursor,
    "Consume ORDER BY USING OPERATOR",
  ).cursor;
  const opening = inspectCurrentSqlReadToken(
    current,
    "Inspect ORDER BY USING OPERATOR opening parenthesis",
  );
  current = opening.cursor;
  if (opening.token?.text !== "(") {
    return unexpectedSqlReadToken(
      current,
      "ORDER BY USING OPERATOR requires an opening parenthesis",
    );
  }

  const outer = current;
  const nested = enterSqlReadDepth(
    outer,
    "Enter ORDER BY USING OPERATOR name",
  );
  const matched = matchingSqlReadDelimiter(
    nested,
    "Match ORDER BY USING OPERATOR parentheses",
  );
  const afterOpening = consumeSqlReadToken(
    matched.cursor,
    "Consume ORDER BY USING OPERATOR opening parenthesis",
  ).cursor;
  const innerParent = afterOpening;
  current = narrowSqlReadCursor(
    afterOpening,
    matched.closeIndex,
    "Bound ORDER BY USING OPERATOR name",
  );

  while (true) {
    const part = inspectCurrentSqlReadToken(
      current,
      "Inspect ORDER BY USING qualified operator part",
    );
    current = part.cursor;
    if (part.token === undefined) {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY USING OPERATOR requires an operator name",
      );
    }
    if (part.token.kind === "operator") {
      if (!isPostgreSqlAllOperator(part.token)) {
        return unexpectedSqlReadToken(
          current,
          `ORDER BY USING OPERATOR requires a PostgreSQL all_Op operator; "${part.token.text}" is reserved syntax`,
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume ORDER BY USING qualified operator name",
      ).cursor;
      const end = inspectCurrentSqlReadToken(
        current,
        "Inspect end of ORDER BY USING qualified operator",
      );
      current = end.cursor;
      if (end.token !== undefined) {
        return unexpectedSqlReadToken(
          current,
          "ORDER BY USING OPERATOR cannot contain tokens after the operator name",
        );
      }
      break;
    }
    if (part.token.kind !== "identifier" || !isPostgreSqlColId(part.token)) {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY USING OPERATOR requires dot-separated PostgreSQL identifiers followed by an operator name",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY USING operator qualifier",
    ).cursor;
    const dot = inspectCurrentSqlReadToken(
      current,
      "Inspect ORDER BY USING operator qualifier dot",
    );
    current = dot.cursor;
    if (dot.token?.text !== ".") {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY USING OPERATOR qualifier requires a following dot",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY USING operator qualifier dot",
    ).cursor;
  }

  current = resumeSqlReadCursor(
    innerParent,
    current,
    "Resume ORDER BY USING OPERATOR name",
  );
  const closing = consumeSqlReadToken(
    current,
    "Consume ORDER BY USING OPERATOR closing parenthesis",
  );
  if (closing.token.text !== ")") {
    return sqlReadInvariant(
      closing.cursor,
      "ORDER BY USING OPERATOR delimiter lookup did not resume at a closing parenthesis",
    );
  }
  return resumeSqlReadCursor(
    outer,
    closing.cursor,
    "Resume ORDER BY USING OPERATOR parentheses",
  );
};

const readSortOperator = (
  cursor: SqlReadCursor,
): SqlReadCursor => {
  const inspected = inspectCurrentSqlReadToken(
    cursor,
    "Inspect ORDER BY USING operator",
  );
  if (inspected.token?.kind === "operator") {
    if (!isPostgreSqlAllOperator(inspected.token)) {
      return unexpectedSqlReadToken(
        inspected.cursor,
        `ORDER BY USING requires a PostgreSQL all_Op operator; "${inspected.token.text}" is reserved syntax`,
      );
    }
    return consumeSqlReadToken(
      inspected.cursor,
      "Consume ORDER BY USING operator",
    ).cursor;
  }
  if (postgreSqlTokenWord(inspected.token) === "operator") {
    return readQualifiedSortOperator(inspected.cursor);
  }
  return unexpectedSqlReadToken(
    inspected.cursor,
    "ORDER BY USING requires an operator",
  );
};

const readSortItemSuffix = (
  cursor: SqlReadCursor,
): SqlReadProbe => {
  let current = cursor;
  let direction: "keyword" | "using" | null = null;
  let inspected = inspectCurrentSqlReadToken(
    current,
    "Inspect ORDER BY direction",
  );
  current = inspected.cursor;
  let word = postgreSqlTokenWord(inspected.token);
  if (word === "asc" || word === "desc") {
    direction = "keyword";
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY direction",
    ).cursor;
  } else if (word === "using") {
    direction = "using";
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY USING",
    ).cursor;
    current = readSortOperator(current);
  }

  let hasNulls = false;
  inspected = inspectCurrentSqlReadToken(
    current,
    "Inspect ORDER BY NULLS ordering",
  );
  current = inspected.cursor;
  word = postgreSqlTokenWord(inspected.token);
  if (word === "nulls") {
    hasNulls = true;
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY NULLS",
    ).cursor;
    const ordering = inspectCurrentSqlReadToken(
      current,
      "Inspect ORDER BY NULLS keyword",
    );
    current = ordering.cursor;
    const orderingWord = postgreSqlTokenWord(ordering.token);
    if (orderingWord !== "first" && orderingWord !== "last") {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY NULLS requires FIRST or LAST",
      );
    }
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY NULLS keyword",
    ).cursor;
  }

  const terminator = inspectCurrentSqlReadToken(
    current,
    "Inspect ORDER BY item terminator",
  );
  current = terminator.cursor;
  const terminatorWord = postgreSqlTokenWord(terminator.token);
  if (isSortSuffixWord(terminatorWord)) {
    return malformedSortSuffix(
      current,
      terminatorWord ?? "suffix",
      direction,
      hasNulls,
    );
  }
  return Object.freeze({ cursor: current, token: terminator.token });
};

export const readSqlSortList = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpression: SqlExpressionReader<SqlExpressionResult>,
): SqlExpressionResult => {
  const initial = cursor;
  const metadata = metadataAccumulator();
  let current = cursor;
  let itemCount = 0;

  while (true) {
    const itemStart = current;
    const scanned = scanSortExpressionEnd(itemStart);
    if (scanned.index === itemStart.index) {
      const inspected = inspectCurrentSqlReadToken(
        scanned,
        "Inspect missing ORDER BY expression",
      );
      return emptySortExpressionMessage(
        inspected.cursor,
        inspected.token,
        itemCount,
      );
    }
    const restored = restoreSqlReadPosition(
      itemStart,
      scanned,
      "Restore ORDER BY expression position",
    );
    const expression = readExactSqlExpression(
      environment,
      restored,
      scanned.index,
      readExpression,
      "ORDER BY expression",
    );
    appendExpressionMetadata(metadata, expression.metadata);
    current = expression.cursor;
    itemCount++;

    const suffix = readSortItemSuffix(current);
    current = suffix.cursor;
    const terminator = suffix.token;
    if (terminator === undefined) {
      return expressionResult(initial, current, metadata);
    }
    if (terminator.text !== ",") {
      return unexpectedSqlReadToken(
        current,
        "Expected a comma between ORDER BY items",
      );
    }
    const commaRange = terminator.range;
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY item comma",
    ).cursor;
    const next = inspectCurrentSqlReadToken(
      current,
      "Inspect expression after ORDER BY comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return throwSqlPolicyParserError(
        "unexpected_token",
        "ORDER BY cannot end with a comma",
        commaRange,
      );
    }
    if (next.token.text === ",") {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY item requires an expression before comma",
      );
    }
  }
};

/** @internal Reads an ORDER BY sort list prefix and leaves its terminator unconsumed. */
export const readSqlSortListPrefix = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlExpressionResult => {
  const initial = cursor;
  const metadata = metadataAccumulator();
  let current = cursor;
  const first = inspectCurrentSqlReadToken(
    current,
    "Inspect first ORDER BY prefix expression",
  );
  current = first.cursor;
  if (first.token === undefined || first.token.text === ",") {
    return emptySortExpressionMessage(current, first.token, 0);
  }

  while (true) {
    const expression = readPrefixSqlExpression(
      environment,
      current,
      readExpressionPrefix,
    );
    appendExpressionMetadata(metadata, expression.metadata);
    current = expression.cursor;

    const suffix = readSortItemSuffix(current);
    current = suffix.cursor;
    if (suffix.token?.text !== ",") {
      return expressionResult(initial, current, metadata);
    }

    const commaRange = suffix.token.range;
    current = consumeSqlReadToken(
      current,
      "Consume ORDER BY item comma",
    ).cursor;
    const next = inspectCurrentSqlReadToken(
      current,
      "Inspect expression after ORDER BY comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return throwSqlPolicyParserError(
        "unexpected_token",
        "ORDER BY cannot end with a comma",
        commaRange,
      );
    }
    if (next.token.text === ",") {
      return unexpectedSqlReadToken(
        current,
        "ORDER BY item requires an expression before comma",
      );
    }
  }
};
