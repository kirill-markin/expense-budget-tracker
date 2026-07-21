import type {
  SqlIdentifierToken,
  SqlSourceRange,
} from "./sql-policy-lexer.js";
import {
  isPostgreSqlColId,
  isPostgreSqlTypeFunctionName,
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
import {
  concatSqlExpressionMetadataSequences,
  emptySqlExpressionMetadataSequence,
  sqlCallMetadataSequence,
  type SqlExpressionMetadataSequence,
} from "./sql-policy-read-metadata.js";
import type { SqlCallNode } from "./sql-policy-read-model.js";
import { readSqlSortListPrefix } from "./sql-policy-read-sort.js";
import {
  consumeSqlReadToken,
  enterSqlReadDepth,
  inspectSqlReadToken,
  matchingSqlReadDelimiter,
  narrowSqlReadCursor,
  resumeEnteredSqlReadCursor,
  resumeSqlReadCursor,
  sqlReadRangeForSpan,
  sqlTokenCursorFromReadCursor,
  type SqlReadCursor,
} from "./sql-policy-read-state.js";
import { readSqlWindowSpecification } from "./sql-policy-read-window.js";

type SqlReadProbe = Readonly<{
  cursor: SqlReadCursor;
  token: SqlParserToken | undefined;
}>;

type SqlCallablePathRead = Readonly<{
  cursor: SqlReadCursor;
  path: ReadonlyArray<SqlIdentifierToken>;
}>;

type SqlParenthesizedRead = Readonly<{
  body: SqlReadCursor;
  contentParent: SqlReadCursor;
  opening: SqlParserToken;
  parent: SqlReadCursor;
}>;

type SqlParenthesizedCompletion = Readonly<{
  closing: SqlParserToken;
  cursor: SqlReadCursor;
}>;

type SqlFunctionArgumentRead = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadataSequence;
  named: SqlIdentifierToken | null;
}>;

type SqlFunctionArgumentsRead = Readonly<{
  cursor: SqlReadCursor;
  hasAggregateOrder: boolean;
  hasDistinct: boolean;
  hasVariadic: boolean;
  metadata: SqlExpressionMetadataSequence;
}>;

type SqlAggregateOrderRead = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadataSequence;
}>;

type SqlAggregateOrderProbe = Readonly<{
  cursor: SqlReadCursor;
  ordered: SqlAggregateOrderRead | null;
}>;

type SqlFunctionDecoratorRead = Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadataSequence;
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
  readCursorRange(cursor, "Report SQL function-reader error"),
);

const unexpectedSqlTokenRange = (
  range: SqlSourceRange,
  message: string,
): never => throwSqlPolicyParserError(
  "unexpected_token",
  message,
  range,
);

const sqlReadInvariant = (
  cursor: SqlReadCursor,
  message: string,
): never => throwSqlPolicyParserError(
  "internal_invariant",
  message,
  readCursorRange(cursor, "Report SQL function-reader invariant"),
);

const inspectCurrentSqlReadToken = (
  cursor: SqlReadCursor,
  operation: string,
): SqlReadProbe => inspectSqlReadToken(cursor, 0, operation);

const consumeExpectedWord = (
  cursor: SqlReadCursor,
  word: string,
  message: string,
  operation: string,
): SqlReadCursor => {
  const inspected = inspectCurrentSqlReadToken(cursor, operation);
  if (postgreSqlTokenWord(inspected.token) !== word) {
    return unexpectedSqlReadToken(inspected.cursor, message);
  }
  return consumeSqlReadToken(inspected.cursor, operation).cursor;
};

const readSqlCallablePath = (
  cursor: SqlReadCursor,
): SqlCallablePathRead => {
  const first = inspectCurrentSqlReadToken(
    cursor,
    "Inspect PostgreSQL callable name",
  );
  if (first.token?.kind !== "identifier") {
    return unexpectedSqlReadToken(
      first.cursor,
      "PostgreSQL function application requires a callable name",
    );
  }

  const firstName = first.token;
  const path: Array<SqlIdentifierToken> = [firstName];
  let current = consumeSqlReadToken(
    first.cursor,
    "Consume PostgreSQL callable name",
  ).cursor;
  let separator = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL callable-name continuation",
  );
  current = separator.cursor;

  if (separator.token?.text === "(") {
    if (!isPostgreSqlTypeFunctionName(firstName)) {
      return unexpectedSqlTokenRange(
        firstName.range,
        `"${firstName.text}" is not a PostgreSQL type_function_name callable identifier`,
      );
    }
    return Object.freeze({ cursor: current, path: Object.freeze(path) });
  }

  if (separator.token?.text !== ".") {
    return unexpectedSqlReadToken(
      current,
      "PostgreSQL callable name requires an opening parenthesis",
    );
  }
  if (!isPostgreSqlColId(firstName)) {
    return unexpectedSqlTokenRange(
      firstName.range,
      `"${firstName.text}" is not a PostgreSQL ColId callable qualifier`,
    );
  }

  while (separator.token?.text === ".") {
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL callable-name dot",
    ).cursor;
    const part = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL qualified callable-name part",
    );
    current = part.cursor;
    if (part.token?.kind !== "identifier") {
      return unexpectedSqlReadToken(
        current,
        "PostgreSQL qualified callable name requires an identifier after dot",
      );
    }
    path.push(part.token);
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL qualified callable-name part",
    ).cursor;
    separator = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL qualified callable-name continuation",
    );
    current = separator.cursor;
  }

  if (separator.token?.text !== "(") {
    return unexpectedSqlReadToken(
      current,
      "PostgreSQL qualified callable name requires an opening parenthesis",
    );
  }
  return Object.freeze({ cursor: current, path: Object.freeze(path) });
};

const enterParenthesizedSqlRead = (
  cursor: SqlReadCursor,
  subject: string,
): SqlParenthesizedRead => {
  const opening = inspectCurrentSqlReadToken(
    cursor,
    `Inspect ${subject} opening parenthesis`,
  );
  if (opening.token?.text !== "(") {
    return unexpectedSqlReadToken(
      opening.cursor,
      `${subject} requires an opening parenthesis`,
    );
  }
  const nested = enterSqlReadDepth(opening.cursor, `Enter ${subject}`);
  const matched = matchingSqlReadDelimiter(
    nested,
    `Match ${subject} parentheses`,
  );
  const consumed = consumeSqlReadToken(
    matched.cursor,
    `Consume ${subject} opening parenthesis`,
  );
  if (consumed.token.text !== "(") {
    return sqlReadInvariant(
      consumed.cursor,
      `${subject} opening-parenthesis inspection changed before consumption`,
    );
  }
  return Object.freeze({
    body: narrowSqlReadCursor(
      consumed.cursor,
      matched.closeIndex,
      `Bound ${subject} contents`,
    ),
    contentParent: consumed.cursor,
    opening: consumed.token,
    parent: cursor,
  });
};

const completeParenthesizedSqlRead = (
  opened: SqlParenthesizedRead,
  body: SqlReadCursor,
  subject: string,
): SqlParenthesizedCompletion => {
  if (body.index !== body.endIndex) {
    return sqlReadInvariant(
      body,
      `${subject} body returned cursor ${String(body.index)}..${String(body.endIndex)} before its exact closing parenthesis`,
    );
  }
  const atClosing = resumeSqlReadCursor(
    opened.contentParent,
    body,
    `Resume ${subject} contents`,
  );
  const closing = consumeSqlReadToken(
    atClosing,
    `Consume ${subject} closing parenthesis`,
  );
  if (closing.token.text !== ")") {
    return sqlReadInvariant(
      closing.cursor,
      `${subject} delimiter lookup did not resume at a closing parenthesis`,
    );
  }
  return Object.freeze({
    closing: closing.token,
    cursor: resumeSqlReadCursor(
      opened.parent,
      closing.cursor,
      `Resume ${subject}`,
    ),
  });
};

const isNamedArgumentOperator = (
  token: SqlParserToken | undefined,
): boolean => token?.text === "=>" || token?.text === ":=";

const readFunctionArgumentExpression = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): Readonly<{
  cursor: SqlReadCursor;
  metadata: SqlExpressionMetadataSequence;
}> => {
  const nested = enterSqlReadDepth(
    cursor,
    "Enter PostgreSQL function argument expression prefix",
  );
  const result = readExpressionPrefix(environment, nested);
  const resumed = resumeEnteredSqlReadCursor(
    cursor,
    nested,
    result.cursor,
    "Resume PostgreSQL function argument expression prefix",
  );
  if (resumed.index === cursor.index) {
    return sqlReadInvariant(
      resumed,
      "PostgreSQL function argument expression prefix reader returned an empty expression",
    );
  }
  return Object.freeze({ cursor: resumed, metadata: result.metadata });
};

const readFunctionArgument = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
  hasNamedArgument: boolean,
  namedArguments: ReadonlySet<string>,
): SqlFunctionArgumentRead => {
  const first = inspectCurrentSqlReadToken(
    cursor,
    "Inspect PostgreSQL function argument",
  );
  const second = inspectSqlReadToken(
    first.cursor,
    1,
    "Inspect PostgreSQL named-argument operator",
  );
  let current = second.cursor;
  let named: SqlIdentifierToken | null = null;

  if (isNamedArgumentOperator(second.token)) {
    if (
      first.token?.kind !== "identifier"
      || !isPostgreSqlTypeFunctionName(first.token)
    ) {
      return unexpectedSqlReadToken(
        first.cursor,
        "PostgreSQL named argument requires a param_name from the type_function_name token class",
      );
    }
    if (namedArguments.has(first.token.normalized)) {
      return unexpectedSqlTokenRange(
        first.token.range,
        `PostgreSQL function argument name "${first.token.text}" is used more than once`,
      );
    }
    named = first.token;
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL named-argument name",
    ).cursor;
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL named-argument operator",
    ).cursor;
  } else if (hasNamedArgument) {
    return unexpectedSqlReadToken(
      first.cursor,
      "PostgreSQL positional argument cannot follow a named argument",
    );
  }

  const expression = readFunctionArgumentExpression(
    environment,
    current,
    readExpressionPrefix,
  );
  return Object.freeze({
    cursor: expression.cursor,
    metadata: expression.metadata,
    named,
  });
};

const readAggregateOrderBy = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlAggregateOrderRead => {
  let current = consumeExpectedWord(
    cursor,
    "order",
    "PostgreSQL aggregate ORDER BY requires ORDER",
    "Consume PostgreSQL aggregate ORDER keyword",
  );
  current = consumeExpectedWord(
    current,
    "by",
    "PostgreSQL aggregate ORDER requires BY",
    "Consume PostgreSQL aggregate ORDER BY keyword",
  );
  const entered = enterSqlReadDepth(
    current,
    "Enter PostgreSQL aggregate ORDER BY sort list",
  );
  const sorted = readSqlSortListPrefix(
    environment,
    entered,
    readExpressionPrefix,
  );
  const resumed = resumeEnteredSqlReadCursor(
    current,
    entered,
    sorted.cursor,
    "Resume PostgreSQL aggregate ORDER BY sort list",
  );
  if (resumed.index !== resumed.endIndex) {
    return unexpectedSqlReadToken(
      resumed,
      "Unexpected token in PostgreSQL aggregate ORDER BY clause",
    );
  }
  return Object.freeze({ cursor: resumed, metadata: sorted.metadata });
};

const readAggregateOrderByIfPresent = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlAggregateOrderProbe => {
  const order = inspectCurrentSqlReadToken(
    cursor,
    "Inspect PostgreSQL aggregate ORDER keyword",
  );
  if (postgreSqlTokenWord(order.token) !== "order") {
    return Object.freeze({ cursor: order.cursor, ordered: null });
  }
  const by = inspectSqlReadToken(
    order.cursor,
    1,
    "Inspect PostgreSQL aggregate ORDER BY keyword",
  );
  if (postgreSqlTokenWord(by.token) !== "by") {
    return unexpectedSqlReadToken(
      order.cursor,
      "Expected a comma or ORDER BY after PostgreSQL function argument",
    );
  }
  return Object.freeze({
    cursor: by.cursor,
    ordered: readAggregateOrderBy(
      environment,
      by.cursor,
      readExpressionPrefix,
    ),
  });
};

const finishVariadicFunctionArguments = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): Readonly<{
  cursor: SqlReadCursor;
  hasAggregateOrder: boolean;
  metadata: SqlExpressionMetadataSequence;
}> => {
  const terminator = inspectCurrentSqlReadToken(
    cursor,
    "Inspect PostgreSQL VARIADIC argument terminator",
  );
  if (terminator.token === undefined) {
    return Object.freeze({
      cursor: terminator.cursor,
      hasAggregateOrder: false,
      metadata: emptySqlExpressionMetadataSequence(),
    });
  }
  if (terminator.token.text === ",") {
    return unexpectedSqlReadToken(
      terminator.cursor,
      "PostgreSQL VARIADIC argument must be the final function argument",
    );
  }
  const orderProbe = readAggregateOrderByIfPresent(
    environment,
    terminator.cursor,
    readExpressionPrefix,
  );
  if (orderProbe.ordered === null) {
    return unexpectedSqlReadToken(
      orderProbe.cursor,
      "Expected ORDER BY or the closing parenthesis after PostgreSQL VARIADIC argument",
    );
  }
  const ordered = orderProbe.ordered;
  return Object.freeze({
    cursor: ordered.cursor,
    hasAggregateOrder: true,
    metadata: ordered.metadata,
  });
};

const missingFunctionArgument = (
  cursor: SqlReadCursor,
  selector: "all" | "distinct" | null,
  selectorRange: SqlSourceRange | null,
): never => {
  if (selector === null) {
    return unexpectedSqlReadToken(
      cursor,
      "PostgreSQL function argument list requires an expression",
    );
  }
  if (selectorRange === null) {
    return sqlReadInvariant(
      cursor,
      "Selected PostgreSQL function argument branch lost its selector range",
    );
  }
  return unexpectedSqlTokenRange(
    selectorRange,
    `${selector.toUpperCase()} requires at least one PostgreSQL function argument`,
  );
};

const requireVariadicFunctionArgument = (
  cursor: SqlReadCursor,
  variadicRange: SqlSourceRange,
): SqlReadCursor => {
  const inspected = inspectCurrentSqlReadToken(
    cursor,
    "Inspect PostgreSQL VARIADIC function argument",
  );
  if (inspected.token === undefined) {
    return unexpectedSqlTokenRange(
      variadicRange,
      "PostgreSQL VARIADIC requires a function argument expression",
    );
  }
  return inspected.cursor;
};

const readSqlFunctionArguments = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlFunctionArgumentsRead => {
  let metadata = emptySqlExpressionMetadataSequence();
  const namedArguments: Set<string> = new Set<string>();
  let current = cursor;
  let selector: "all" | "distinct" | null = null;
  let selectorRange: SqlSourceRange | null = null;
  let hasNamedArgument = false;

  let first = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL function argument branch",
  );
  current = first.cursor;
  if (first.token === undefined) {
    return Object.freeze({
      cursor: current,
      hasAggregateOrder: false,
      hasDistinct: false,
      hasVariadic: false,
      metadata,
    });
  }

  if (first.token.text === "*") {
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL star function argument",
    ).cursor;
    const trailing = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL star function-argument terminator",
    );
    if (trailing.token !== undefined) {
      return unexpectedSqlReadToken(
        trailing.cursor,
        "PostgreSQL star function argument must appear alone",
      );
    }
    return Object.freeze({
      cursor: trailing.cursor,
      hasAggregateOrder: false,
      hasDistinct: false,
      hasVariadic: false,
      metadata,
    });
  }

  const firstWord = postgreSqlTokenWord(first.token);
  if (firstWord === "all" || firstWord === "distinct") {
    selector = firstWord;
    selectorRange = first.token.range;
    current = consumeSqlReadToken(
      current,
      `Consume PostgreSQL ${firstWord.toUpperCase()} function-argument selector`,
    ).cursor;
    first = inspectCurrentSqlReadToken(
      current,
      `Inspect first PostgreSQL ${firstWord.toUpperCase()} function argument`,
    );
    current = first.cursor;
    if (first.token === undefined) {
      return missingFunctionArgument(current, selector, selectorRange);
    }
    if (first.token.text === "*") {
      return unexpectedSqlReadToken(
        current,
        `${firstWord.toUpperCase()} function arguments cannot use the star branch`,
      );
    }
    if (postgreSqlTokenWord(first.token) === "variadic") {
      return unexpectedSqlReadToken(
        current,
        `${firstWord.toUpperCase()} function arguments cannot use VARIADIC`,
      );
    }
  }

  if (postgreSqlTokenWord(first.token) === "variadic") {
    if (first.token === undefined) {
      return sqlReadInvariant(
        current,
        "PostgreSQL VARIADIC branch lost its keyword token",
      );
    }
    const variadicRange = first.token.range;
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL leading VARIADIC keyword",
    ).cursor;
    current = requireVariadicFunctionArgument(current, variadicRange);
    const variadic = readFunctionArgument(
      environment,
      current,
      readExpressionPrefix,
      false,
      namedArguments,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      variadic.metadata,
    );
    const finished = finishVariadicFunctionArguments(
      environment,
      variadic.cursor,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      finished.metadata,
    );
    return Object.freeze({
      cursor: finished.cursor,
      hasAggregateOrder: finished.hasAggregateOrder,
      hasDistinct: false,
      hasVariadic: true,
      metadata,
    });
  }

  while (true) {
    const argument = readFunctionArgument(
      environment,
      current,
      readExpressionPrefix,
      hasNamedArgument,
      namedArguments,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      argument.metadata,
    );
    current = argument.cursor;
    if (argument.named !== null) {
      namedArguments.add(argument.named.normalized);
      hasNamedArgument = true;
    }

    const terminator = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL function-argument terminator",
    );
    current = terminator.cursor;
    if (terminator.token === undefined) {
      return Object.freeze({
        cursor: current,
        hasAggregateOrder: false,
        hasDistinct: selector === "distinct",
        hasVariadic: false,
        metadata,
      });
    }

    const orderProbe = readAggregateOrderByIfPresent(
      environment,
      current,
      readExpressionPrefix,
    );
    current = orderProbe.cursor;
    if (orderProbe.ordered !== null) {
      const ordered = orderProbe.ordered;
      metadata = concatSqlExpressionMetadataSequences(
        metadata,
        ordered.metadata,
      );
      return Object.freeze({
        cursor: ordered.cursor,
        hasAggregateOrder: true,
        hasDistinct: selector === "distinct",
        hasVariadic: false,
        metadata,
      });
    }

    if (terminator.token.text !== ",") {
      return unexpectedSqlReadToken(
        current,
        "Expected a comma between PostgreSQL function arguments",
      );
    }
    const commaRange = terminator.token.range;
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL function-argument comma",
    ).cursor;
    const next = inspectCurrentSqlReadToken(
      current,
      "Inspect PostgreSQL function argument after comma",
    );
    current = next.cursor;
    if (next.token === undefined) {
      return unexpectedSqlTokenRange(
        commaRange,
        "PostgreSQL function argument list cannot end with a comma",
      );
    }
    if (next.token.text === ",") {
      return unexpectedSqlReadToken(
        current,
        "PostgreSQL function argument requires an expression before comma",
      );
    }

    if (postgreSqlTokenWord(next.token) !== "variadic") {
      continue;
    }
    if (selector !== null) {
      return unexpectedSqlReadToken(
        current,
        `${selector.toUpperCase()} function arguments cannot use VARIADIC`,
      );
    }
    const variadicRange = next.token.range;
    current = consumeSqlReadToken(
      current,
      "Consume PostgreSQL final VARIADIC keyword",
    ).cursor;
    current = requireVariadicFunctionArgument(current, variadicRange);
    const variadic = readFunctionArgument(
      environment,
      current,
      readExpressionPrefix,
      hasNamedArgument,
      namedArguments,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      variadic.metadata,
    );
    const finished = finishVariadicFunctionArguments(
      environment,
      variadic.cursor,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      finished.metadata,
    );
    return Object.freeze({
      cursor: finished.cursor,
      hasAggregateOrder: finished.hasAggregateOrder,
      hasDistinct: false,
      hasVariadic: true,
      metadata,
    });
  }
};

const readWithinGroupDecorator = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlFunctionDecoratorRead => {
  let current = consumeExpectedWord(
    cursor,
    "within",
    "PostgreSQL WITHIN GROUP decorator requires WITHIN",
    "Consume PostgreSQL WITHIN keyword",
  );
  current = consumeExpectedWord(
    current,
    "group",
    "WITHIN requires GROUP in a PostgreSQL function decorator",
    "Consume PostgreSQL WITHIN GROUP keyword",
  );
  const opened = enterParenthesizedSqlRead(current, "WITHIN GROUP decorator");
  current = consumeExpectedWord(
    opened.body,
    "order",
    "WITHIN GROUP requires ORDER BY",
    "Consume WITHIN GROUP ORDER keyword",
  );
  current = consumeExpectedWord(
    current,
    "by",
    "WITHIN GROUP ORDER requires BY",
    "Consume WITHIN GROUP ORDER BY keyword",
  );
  const entered = enterSqlReadDepth(
    current,
    "Enter WITHIN GROUP ORDER BY sort list",
  );
  const sorted = readSqlSortListPrefix(
    environment,
    entered,
    readExpressionPrefix,
  );
  const resumed = resumeEnteredSqlReadCursor(
    current,
    entered,
    sorted.cursor,
    "Resume WITHIN GROUP ORDER BY sort list",
  );
  if (resumed.index !== resumed.endIndex) {
    return unexpectedSqlReadToken(
      resumed,
      "Unexpected token in WITHIN GROUP ORDER BY clause",
    );
  }
  const completed = completeParenthesizedSqlRead(
    opened,
    resumed,
    "WITHIN GROUP decorator",
  );
  return Object.freeze({
    cursor: completed.cursor,
    metadata: sorted.metadata,
  });
};

const readFilterDecorator = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlFunctionDecoratorRead => {
  let current = consumeExpectedWord(
    cursor,
    "filter",
    "PostgreSQL FILTER decorator requires FILTER",
    "Consume PostgreSQL FILTER keyword",
  );
  const opened = enterParenthesizedSqlRead(current, "FILTER decorator");
  current = consumeExpectedWord(
    opened.body,
    "where",
    "FILTER requires WHERE",
    "Consume PostgreSQL FILTER WHERE keyword",
  );
  const first = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL FILTER expression",
  );
  current = first.cursor;
  if (first.token === undefined) {
    return unexpectedSqlReadToken(
      current,
      "FILTER WHERE requires an expression",
    );
  }
  const nested = enterSqlReadDepth(
    current,
    "Enter PostgreSQL FILTER expression prefix",
  );
  const expression = readExpressionPrefix(environment, nested);
  const resumed = resumeEnteredSqlReadCursor(
    current,
    nested,
    expression.cursor,
    "Resume PostgreSQL FILTER expression prefix",
  );
  if (resumed.index === current.index) {
    return sqlReadInvariant(
      resumed,
      "PostgreSQL FILTER expression prefix reader returned an empty expression",
    );
  }
  if (resumed.index !== resumed.endIndex) {
    return unexpectedSqlReadToken(
      resumed,
      "Unexpected token after PostgreSQL FILTER expression",
    );
  }
  const completed = completeParenthesizedSqlRead(
    opened,
    resumed,
    "FILTER decorator",
  );
  return Object.freeze({
    cursor: completed.cursor,
    metadata: expression.metadata,
  });
};

const readOverDecorator = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlFunctionDecoratorRead => {
  let current = consumeExpectedWord(
    cursor,
    "over",
    "PostgreSQL OVER decorator requires OVER",
    "Consume PostgreSQL OVER keyword",
  );
  const target = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL OVER target",
  );
  current = target.cursor;
  if (target.token?.text === "(") {
    const opened = enterParenthesizedSqlRead(current, "OVER decorator");
    const entered = enterSqlReadDepth(
      opened.body,
      "Enter OVER window specification",
    );
    const window = readSqlWindowSpecification(
      environment,
      entered,
      readExpressionPrefix,
    );
    const resumed = resumeEnteredSqlReadCursor(
      opened.body,
      entered,
      window.cursor,
      "Resume exact OVER window specification",
    );
    if (resumed.index !== resumed.endIndex) {
      return sqlReadInvariant(
        resumed,
        `Window specification reader returned cursor ${String(resumed.index)}..${String(resumed.endIndex)} before the OVER closing parenthesis`,
      );
    }
    const completed = completeParenthesizedSqlRead(
      opened,
      resumed,
      "OVER decorator",
    );
    return Object.freeze({
      cursor: completed.cursor,
      metadata: window.metadata,
    });
  }
  if (target.token?.kind !== "identifier" || !isPostgreSqlColId(target.token)) {
    return unexpectedSqlReadToken(
      current,
      "OVER requires a PostgreSQL ColId window name or parenthesized window specification",
    );
  }
  return Object.freeze({
    cursor: consumeSqlReadToken(
      current,
      "Consume PostgreSQL OVER window name",
    ).cursor,
    metadata: emptySqlExpressionMetadataSequence(),
  });
};

const rejectTrailingFunctionDecorator = (
  cursor: SqlReadCursor,
  hasWithinGroup: boolean,
  hasFilter: boolean,
  hasOver: boolean,
): SqlReadCursor => {
  const trailing = inspectCurrentSqlReadToken(
    cursor,
    "Inspect trailing PostgreSQL function decorator",
  );
  const word = postgreSqlTokenWord(trailing.token);
  if (word === "within") {
    return unexpectedSqlReadToken(
      trailing.cursor,
      hasWithinGroup
        ? "PostgreSQL function application cannot contain more than one WITHIN GROUP decorator"
        : "WITHIN GROUP must appear before FILTER and OVER",
    );
  }
  if (word === "filter") {
    return unexpectedSqlReadToken(
      trailing.cursor,
      hasFilter
        ? "PostgreSQL function application cannot contain more than one FILTER decorator"
        : "FILTER must appear before OVER",
    );
  }
  if (word === "over") {
    return unexpectedSqlReadToken(
      trailing.cursor,
      hasOver
        ? "PostgreSQL function application cannot contain more than one OVER decorator"
        : "Unexpected OVER decorator after PostgreSQL function application",
    );
  }
  return trailing.cursor;
};

/** Reads one PostgreSQL generic function application prefix and its decorators. */
export const readSqlFunctionApplication = (
  environment: SqlExpressionEnvironment,
  cursor: SqlReadCursor,
  readExpressionPrefix: SqlExpressionPrefixReader,
): SqlExpressionResult => {
  const initial = cursor;
  const callable = readSqlCallablePath(cursor);
  const opened = enterParenthesizedSqlRead(
    callable.cursor,
    "PostgreSQL function application",
  );
  const argumentsRead = readSqlFunctionArguments(
    environment,
    opened.body,
    readExpressionPrefix,
  );
  const application = completeParenthesizedSqlRead(
    opened,
    argumentsRead.cursor,
    "PostgreSQL function application",
  );
  const applicationRange = sqlReadRangeForSpan(
    initial.state,
    initial.index,
    application.cursor.index,
  );
  const call: SqlCallNode = Object.freeze({
    argumentsRange: Object.freeze({
      start: opened.opening.range.end,
      end: application.closing.range.start,
    }),
    context: environment.context,
    path: callable.path,
    queryId: environment.queryId,
    range: applicationRange,
    syntaxContext: environment.syntaxContext,
  });
  let metadata = argumentsRead.metadata;
  let current = application.cursor;
  let hasWithinGroup = false;
  let hasFilter = false;
  let hasOver = false;

  let decorator = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL WITHIN GROUP decorator",
  );
  current = decorator.cursor;
  if (postgreSqlTokenWord(decorator.token) === "within") {
    const withinRange = decorator.token?.range;
    const within = readWithinGroupDecorator(
      environment,
      current,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      within.metadata,
    );
    current = within.cursor;
    hasWithinGroup = true;
    if (withinRange === undefined) {
      return sqlReadInvariant(
        current,
        "WITHIN GROUP inspection lost its token range",
      );
    }
    if (argumentsRead.hasAggregateOrder) {
      return unexpectedSqlTokenRange(
        withinRange,
        "Cannot use multiple ORDER BY clauses with WITHIN GROUP",
      );
    }
    if (argumentsRead.hasDistinct) {
      return unexpectedSqlTokenRange(
        withinRange,
        "Cannot use DISTINCT with WITHIN GROUP",
      );
    }
    if (argumentsRead.hasVariadic) {
      return unexpectedSqlTokenRange(
        withinRange,
        "Cannot use VARIADIC with WITHIN GROUP",
      );
    }
  }

  decorator = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL FILTER decorator",
  );
  current = decorator.cursor;
  if (postgreSqlTokenWord(decorator.token) === "filter") {
    const filter = readFilterDecorator(
      environment,
      current,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      filter.metadata,
    );
    current = filter.cursor;
    hasFilter = true;
  }

  decorator = inspectCurrentSqlReadToken(
    current,
    "Inspect PostgreSQL OVER decorator",
  );
  current = decorator.cursor;
  if (postgreSqlTokenWord(decorator.token) === "over") {
    const over = readOverDecorator(
      environment,
      current,
      readExpressionPrefix,
    );
    metadata = concatSqlExpressionMetadataSequences(
      metadata,
      over.metadata,
    );
    current = over.cursor;
    hasOver = true;
  }

  current = rejectTrailingFunctionDecorator(
    current,
    hasWithinGroup,
    hasFilter,
    hasOver,
  );
  return Object.freeze({
    cursor: current,
    metadata: concatSqlExpressionMetadataSequences(
      sqlCallMetadataSequence(call),
      metadata,
    ),
    range: sqlReadRangeForSpan(initial.state, initial.index, current.index),
  });
};
