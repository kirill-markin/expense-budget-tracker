import type { SqlSourceRange } from "./sql-policy-lexer.js";
import {
  isPostgreSqlColId,
  postgreSqlTokenWord,
} from "./sql-policy-parser-keywords.js";
import {
  sqlCursorRange,
  type SqlParserToken,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";
import type {
  SqlExpressionEnvironment,
  SqlExpressionPrefixReader,
  SqlExpressionResult,
} from "./sql-policy-read-expression.js";
import type {
  SqlCallNode,
  SqlExpressionMetadata,
  SqlNestedQueryNode,
  SqlTypeConstructNode,
} from "./sql-policy-read-model.js";
import { readSqlWindowFrame } from "./sql-policy-read-frame.js";
import { readSqlSortListPrefix } from "./sql-policy-read-sort.js";
import {
  consumeSqlReadToken,
  enterSqlReadDepth,
  inspectSqlReadToken,
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

type SqlPartitionExpressionRead = Readonly<{
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
  readCursorRange(cursor, "Report SQL window-reader error"),
);

const sqlReadInvariant = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "internal_invariant",
  message,
  readCursorRange(cursor, "Report SQL window-reader invariant"),
);

const inspectCurrentSqlReadToken = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadProbe => inspectSqlReadToken(cursor, 0, operation);

const isWindowFrameWord = (word: string | null): boolean =>
  word === "groups" || word === "range" || word === "rows";

const isExistingWindowName = (token: SqlParserToken): boolean => {
  if (token.kind !== "identifier" || !isPostgreSqlColId(token)) {
    return false;
  }
  const word = postgreSqlTokenWord(token);
  return word !== "partition" && !isWindowFrameWord(word);
};

const expressionResult = (
  initial: SqlReadCursor,
  cursor: SqlReadCursor,
  metadata: SqlMetadataAccumulator,
): SqlExpressionResult => Object.freeze({
  cursor,
  metadata: expressionMetadata(metadata),
  range: sqlReadRangeForSpan(initial.state, initial.index, cursor.index),
});

const consumeRequiredBy = (
  cursor: SqlReadCursor,
  section: "ORDER" | "PARTITION",
): SqlReadCursor => {
  const inspected = inspectCurrentSqlReadToken(
    cursor,
    `Inspect window ${section} BY keyword`,
  );
  if (postgreSqlTokenWord(inspected.token) !== "by") {
    return unexpectedSqlReadToken(
      inspected.cursor,
      `${section} requires BY in a window specification`,
    );
  }
  return consumeSqlReadToken(
    inspected.cursor,
    `Consume window ${section} BY keyword`,
  ).cursor;
};

const readPartitionExpression = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlPartitionExpressionRead => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter PARTITION BY expression prefix",
  );
  const result = readExpressionPrefix(environment, nested);
  const resumed = resumeSqlReadCursor(
    cursor,
    result.cursor,
    "Resume PARTITION BY expression prefix",
  );
  if (resumed.index === cursor.index) {
    return sqlReadInvariant(
      resumed,
      "PARTITION BY expression prefix reader returned an empty expression",
    );
  }
  return Object.freeze({
    cursor: resumed,
    metadata: result.metadata,
  });
};

const missingPartitionExpression = (
  cursor: SqlReadCursor,
  token: SqlParserToken | undefined,
  itemCount: number,
): never => {
  if (token === undefined && itemCount === 0) {
    return unexpectedSqlReadToken(
      cursor,
      "PARTITION BY requires at least one expression",
    );
  }
  return unexpectedSqlReadToken(
    cursor,
    "PARTITION BY item requires an expression before comma",
  );
};

const readPartitionListPrefix = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadata;
}> => {
  const metadata = metadataAccumulator();
  let current = cursor;
  let itemCount = 0;

  while (true) {
    const first = inspectCurrentSqlReadToken(
      current,
      "Inspect PARTITION BY expression prefix",
    );
    current = first.cursor;
    if (first.token === undefined || first.token.text === ",") {
      return missingPartitionExpression(current, first.token, itemCount);
    }

    const expression = readPartitionExpression(
      environment,
      current,
      readExpressionPrefix,
    );
    appendExpressionMetadata(metadata, expression.metadata);
    current = expression.cursor;
    itemCount++;

    const separator = inspectCurrentSqlReadToken(
      current,
      "Inspect PARTITION BY expression separator",
    );
    current = separator.cursor;
    if (separator.token?.text !== ",") {
      return Object.freeze({
        cursor: current,
        metadata: expressionMetadata(metadata),
      });
    }

    const commaRange = separator.token.range;
    current = consumeSqlReadToken(
      current,
      "Consume PARTITION BY expression comma",
    ).cursor;
    const next = inspectCurrentSqlReadToken(
      current,
      "Inspect PARTITION BY expression after comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return throwSqlPolicyParserError(
        "unexpected_token",
        "PARTITION BY cannot end with a comma",
        commaRange,
      );
    }
    if (next.token.text === ",") {
      return missingPartitionExpression(current, next.token, itemCount);
    }
    const nextWord = postgreSqlTokenWord(next.token);
    if (nextWord === "order" || nextWord === "partition") {
      const by = inspectSqlReadToken(
        current,
        1,
        "Inspect section after PARTITION BY comma",
      );
      current = by.cursor;
      if (postgreSqlTokenWord(by.token) === "by") {
        return throwSqlPolicyParserError(
          "unexpected_token",
          "PARTITION BY cannot end with a comma",
          commaRange,
        );
      }
    }
  }
};

/** Reads one complete PostgreSQL window specification from an exact parent bound. */
export const readSqlWindowSpecification = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlExpressionResult => {
  const initial = cursor;
  const metadata = metadataAccumulator();
  let current = cursor;
  let hasPartition = false;
  let hasOrder = false;

  let inspected = inspectCurrentSqlReadToken(
    current,
    "Inspect existing window name",
  );
  current = inspected.cursor;
  if (inspected.token === undefined) {
    return expressionResult(initial, current, metadata);
  }
  if (isExistingWindowName(inspected.token)) {
    current = consumeSqlReadToken(
      current,
      "Consume existing window name",
    ).cursor;
  }

  while (true) {
    inspected = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL window specification section",
    );
    current = inspected.cursor;
    if (inspected.token === undefined) {
      return expressionResult(initial, current, metadata);
    }
    const word = postgreSqlTokenWord(inspected.token);

    if (word === "partition") {
      if (hasPartition) {
        return unexpectedSqlReadToken(
          current,
          "Window specification cannot contain more than one PARTITION BY clause",
        );
      }
      if (hasOrder) {
        return unexpectedSqlReadToken(
          current,
          "PARTITION BY must appear before ORDER BY and the window frame clause",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume window PARTITION keyword",
      ).cursor;
      current = consumeRequiredBy(current, "PARTITION");
      const partition = readPartitionListPrefix(
        environment,
        current,
        readExpressionPrefix,
      );
      appendExpressionMetadata(metadata, partition.metadata);
      current = partition.cursor;
      hasPartition = true;
      continue;
    }

    if (word === "order") {
      if (hasOrder) {
        return unexpectedSqlReadToken(
          current,
          "Window specification cannot contain more than one ORDER BY clause",
        );
      }
      current = consumeSqlReadToken(
        current,
        "Consume window ORDER keyword",
      ).cursor;
      current = consumeRequiredBy(current, "ORDER");
      const sorted = readSqlSortListPrefix(
        environment,
        current,
        readExpressionPrefix,
      );
      appendExpressionMetadata(metadata, sorted.metadata);
      current = resumeSqlReadCursor(
        current,
        sorted.cursor,
        "Resume window ORDER BY sort-list prefix",
      );
      hasOrder = true;
      continue;
    }

    if (isWindowFrameWord(word)) {
      const frame = readSqlWindowFrame(
        environment,
        current,
        readExpressionPrefix,
      );
      appendExpressionMetadata(metadata, frame.metadata);
      current = resumeSqlReadCursor(
        current,
        frame.cursor,
        "Resume exact window frame clause",
      );
      if (current.index !== current.endIndex) {
        return sqlReadInvariant(
          current,
          `Window frame reader returned cursor ${String(current.index)}..${String(current.endIndex)} but the exact frame span ends at token ${String(current.endIndex)}`,
        );
      }
      return expressionResult(initial, current, metadata);
    }

    return unexpectedSqlReadToken(
      current,
      "Unexpected token in PostgreSQL window specification",
    );
  }
};
