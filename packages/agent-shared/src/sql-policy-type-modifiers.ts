import type {
  SqlStringToken,
  SqlValidNumericToken,
} from "./sql-policy-lexer.js";
import {
  POSTGRESQL_INTERVAL_FIELD_PAIRS,
  POSTGRESQL_INTERVAL_FIELDS,
  isPostgreSqlTypeModifierIdentifier,
  postgreSqlTokenWord,
} from "./sql-policy-parser-keywords.js";
import {
  advanceSqlTokenCursor,
  consumeSqlTokenCursor,
  inspectSqlTokenCursor,
  matchingSqlDelimiterIndexWithinCursor,
  restoreSqlTokenCursorPosition,
  sqlCursorRange,
  sqlRangeFromTokenIndexes,
  sqlTokenAt,
  type SqlParserToken,
  type SqlTokenCursor,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";
import type {
  SqlIntervalField,
  SqlIntervalQualifierNode,
  SqlTypeModifierNode,
  SqlTypeParseResult,
} from "./sql-policy-type-model.js";

export type ParsedIntegerModifier = Readonly<{
  cursor: SqlTokenCursor;
  modifier: SqlTypeModifierNode;
  value: bigint;
}>;

export type ParsedModifierList = Readonly<{
  cursor: SqlTokenCursor;
  modifiers: ReadonlyArray<SqlTypeModifierNode>;
}>;

export type PostgreSqlIntervalQualifierParseAttempt =
  | Readonly<{
    cursor: SqlTokenCursor;
    matched: false;
  }>
  | Readonly<{
    cursor: SqlTokenCursor;
    matched: true;
    node: SqlIntervalQualifierNode;
  }>;

const isText = (
  cursor: SqlTokenCursor,
  offset: number,
  expected: string,
): boolean => sqlTokenAt(cursor, offset)?.text === expected;

export const isPostgreSqlStringConstant = (
  token: SqlParserToken | undefined,
): token is SqlStringToken =>
  token?.kind === "string"
  && token.style !== "bit"
  && token.style !== "hex";

type PostgreSqlNumericConstant =
  | Readonly<{
    semanticValue: string;
    tokenKind: "fconst";
  }>
  | Readonly<{
    semanticValue: string;
    tokenKind: "iconst";
    value: bigint;
  }>;

export type PostgreSqlIntegerConstant = Readonly<{
  semanticValue: string;
  value: bigint;
}>;

const hasPostgreSqlIntegerTokenSyntax = (
  token: SqlValidNumericToken,
): boolean =>
  token.form !== "decimal"
  || (
    !token.text.includes(".")
    && !token.text.includes("e")
    && !token.text.includes("E")
  );

const parsePostgreSqlIntegerTokenValue = (
  token: SqlValidNumericToken,
): bigint | null => {
  const base = token.form === "binary"
    ? 2
    : token.form === "octal"
      ? 8
      : token.form === "hexadecimal"
        ? 16
        : 10;
  const digits = token.form === "decimal"
    ? token.normalized
    : token.normalized.slice(2);
  let value = 0n;
  for (const digit of digits) {
    const digitValue = "0123456789abcdef".indexOf(digit);
    if (digitValue < 0 || digitValue >= base) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        `Valid PostgreSQL ${token.form} integer token ${token.text} contains digit ${digit}`,
        token.range,
      );
    }
    value = (value * BigInt(base)) + BigInt(digitValue);
    if (value > 2_147_483_647n) {
      return null;
    }
  }
  return value;
};

const classifyPostgreSqlNumericConstant = (
  token: SqlParserToken | undefined,
): PostgreSqlNumericConstant | null => {
  if (token?.kind !== "numeric" || !token.valid) {
    return null;
  }
  if (!hasPostgreSqlIntegerTokenSyntax(token)) {
    return {
      semanticValue: token.text,
      tokenKind: "fconst",
    };
  }
  const value = parsePostgreSqlIntegerTokenValue(token);
  if (value === null) {
    return {
      semanticValue: token.text,
      tokenKind: "fconst",
    };
  }
  return {
    semanticValue: value.toString(10),
    tokenKind: "iconst",
    value,
  };
};

export const postgreSqlIntegerConstant = (
  token: SqlParserToken | undefined,
): PostgreSqlIntegerConstant | null => {
  const constant = classifyPostgreSqlNumericConstant(token);
  return constant?.tokenKind === "iconst"
    ? {
      semanticValue: constant.semanticValue,
      value: constant.value,
    }
    : null;
};

const makeModifier = (
  cursor: SqlTokenCursor,
  startIndex: number,
  endIndex: number,
  kind: SqlTypeModifierNode["kind"],
  valueToken: SqlParserToken,
  negative: boolean,
): SqlTypeModifierNode => {
  const range = sqlRangeFromTokenIndexes(
    cursor.kernel,
    startIndex,
    endIndex,
  );
  let normalizedValue: string;
  if (valueToken.kind === "numeric" && valueToken.valid) {
    const constant = classifyPostgreSqlNumericConstant(valueToken);
    if (constant === null) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        `Cannot classify valid PostgreSQL numeric type modifier token ${valueToken.text}`,
        valueToken.range,
      );
    }
    if (!negative) {
      normalizedValue = constant.semanticValue;
    } else if (constant.tokenKind === "iconst") {
      normalizedValue = (-constant.value).toString(10);
    } else {
      normalizedValue = `-${constant.semanticValue}`;
    }
  } else if (isPostgreSqlStringConstant(valueToken)) {
    normalizedValue = valueToken.semanticValue;
  } else if (valueToken.kind === "identifier") {
    normalizedValue = valueToken.normalized;
  } else {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Cannot normalize PostgreSQL ${kind} type modifier token ${valueToken.text}`,
      valueToken.range,
    );
  }
  return {
    kind,
    normalizedValue,
    range,
    sql: cursor.kernel.sql.slice(range.start, range.end),
    valueRange: valueToken.range,
  };
};

export const parsePostgreSqlIntegerModifier = (
  cursor: SqlTokenCursor,
  purpose: string,
): ParsedIntegerModifier => {
  if (!isText(cursor, 0, "(")) {
    return throwSqlPolicyParserError(
      "internal_invariant",
      `Expected ( before ${purpose}`,
      sqlCursorRange(cursor),
    );
  }
  const closeIndex = matchingSqlDelimiterIndexWithinCursor(
    cursor,
    "invalid_type_modifier",
    purpose,
  );
  if (closeIndex !== cursor.index + 2) {
    return throwSqlPolicyParserError(
      "invalid_type_modifier",
      `${purpose} requires exactly one PostgreSQL integer constant`,
      sqlCursorRange(cursor),
    );
  }
  const valueToken = sqlTokenAt(cursor, 1);
  const integerConstant = postgreSqlIntegerConstant(valueToken);
  if (valueToken === undefined || integerConstant === null) {
    return throwSqlPolicyParserError(
      "invalid_type_modifier",
      `${purpose} requires an integer constant between 0 and 2147483647`,
      valueToken?.range ?? sqlCursorRange(cursor),
    );
  }
  const startIndex = cursor.index + 1;
  const next = advanceSqlTokenCursor(cursor, 3, purpose);
  return {
    cursor: next,
    modifier: makeModifier(
      cursor,
      startIndex,
      startIndex + 1,
      "numeric",
      valueToken,
      false,
    ),
    value: integerConstant.value,
  };
};

const parseSimpleTypeModifier = (
  cursor: SqlTokenCursor,
  closeIndex: number,
): Readonly<{
  cursor: SqlTokenCursor;
  modifier: SqlTypeModifierNode;
}> => {
  const startIndex = cursor.index;
  let current = cursor;
  let negative = false;
  let unaryOperatorCount = 0;
  const wrapperCloseIndexes: Array<number> = [];

  while (current.index < closeIndex) {
    const token = sqlTokenAt(current, 0);
    if (token?.text === "+") {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        "PostgreSQL unary plus type modifiers do not resolve to a simple constant",
        token.range,
      );
    }
    if (token?.text === "-") {
      unaryOperatorCount++;
      negative = !negative;
      current = advanceSqlTokenCursor(
        current,
        1,
        "PostgreSQL unary type modifier operator",
      );
      continue;
    }
    if (token?.text === "(") {
      const wrapperCloseIndex = matchingSqlDelimiterIndexWithinCursor(
        current,
        "invalid_type_modifier",
        "Parenthesized PostgreSQL type modifier",
      );
      if (wrapperCloseIndex >= closeIndex) {
        return throwSqlPolicyParserError(
          "invalid_type_modifier",
          "Parenthesized PostgreSQL type modifier closes outside its modifier item",
          token.range,
        );
      }
      wrapperCloseIndexes.push(wrapperCloseIndex);
      current = advanceSqlTokenCursor(
        current,
        1,
        "PostgreSQL parenthesized type modifier",
      );
      continue;
    }
    break;
  }

  const valueToken = sqlTokenAt(current, 0);
  if (valueToken === undefined || current.index >= closeIndex) {
    return throwSqlPolicyParserError(
      "invalid_type_modifier",
      "PostgreSQL type modifier lists cannot contain an empty item",
      sqlCursorRange(current),
    );
  }

  let kind: SqlTypeModifierNode["kind"];
  if (valueToken.kind === "numeric" && valueToken.valid) {
    kind = "numeric";
  } else if (
    unaryOperatorCount === 0
    && isPostgreSqlStringConstant(valueToken)
  ) {
    kind = "string";
  } else if (
    unaryOperatorCount === 0
    && valueToken.kind === "identifier"
    && isPostgreSqlTypeModifierIdentifier(valueToken)
  ) {
    kind = "identifier";
  } else {
    return throwSqlPolicyParserError(
      "invalid_type_modifier",
      unaryOperatorCount > 0
        ? "PostgreSQL unary type modifier operators may only wrap a numeric constant"
        : `PostgreSQL type modifiers must resolve to a simple numeric constant, string constant, or identifier; found ${valueToken.text}`,
      valueToken.range,
    );
  }

  current = advanceSqlTokenCursor(
    current,
    1,
    `PostgreSQL ${kind} type modifier value`,
  );
  for (
    let wrapperIndex = wrapperCloseIndexes.length - 1;
    wrapperIndex >= 0;
    wrapperIndex--
  ) {
    const expectedCloseIndex = wrapperCloseIndexes[wrapperIndex];
    const token = sqlTokenAt(current, 0);
    if (expectedCloseIndex === undefined || current.index !== expectedCloseIndex) {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        `Parenthesized PostgreSQL type modifier contains unsupported expression token ${token?.text ?? "at end of input"}`,
        token?.range ?? sqlCursorRange(current),
      );
    }
    current = advanceSqlTokenCursor(
      current,
      1,
      "PostgreSQL parenthesized type modifier closing delimiter",
    );
  }

  return {
    cursor: current,
    modifier: makeModifier(
      cursor,
      startIndex,
      current.index,
      kind,
      valueToken,
      negative,
    ),
  };
};

export const parsePostgreSqlTypeModifierList = (
  cursor: SqlTokenCursor,
): ParsedModifierList => {
  const open = sqlTokenAt(cursor, 0);
  if (open?.text !== "(") {
    return throwSqlPolicyParserError(
      "internal_invariant",
      "Expected an opening parenthesis for a PostgreSQL type modifier list",
      sqlCursorRange(cursor),
    );
  }
  const closeIndex = matchingSqlDelimiterIndexWithinCursor(
    cursor,
    "invalid_type_modifier",
    "PostgreSQL type modifier list",
  );

  let current = advanceSqlTokenCursor(
    cursor,
    1,
    "PostgreSQL type modifier list",
  );
  if (current.index === closeIndex) {
    return throwSqlPolicyParserError(
      "invalid_type_modifier",
      "PostgreSQL type modifier lists require at least one item",
      open.range,
    );
  }

  const modifiers: Array<SqlTypeModifierNode> = [];
  while (current.index < closeIndex) {
    const parsed = parseSimpleTypeModifier(current, closeIndex);
    modifiers.push(parsed.modifier);
    current = parsed.cursor;
    if (current.index === closeIndex) {
      break;
    }
    const separator = sqlTokenAt(current, 0);
    if (separator?.text !== ",") {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        `Expected , or ) after PostgreSQL type modifier; found ${separator?.text ?? "end of input"}`,
        separator?.range ?? sqlCursorRange(current),
      );
    }
    current = advanceSqlTokenCursor(
      current,
      1,
      "PostgreSQL type modifier separator",
    );
    if (current.index === closeIndex) {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        "PostgreSQL type modifier lists cannot end with a comma",
        separator.range,
      );
    }
  }
  return {
    cursor: advanceSqlTokenCursor(
      current,
      1,
      "PostgreSQL type modifier list closing parenthesis",
    ),
    modifiers,
  };
};

export const parsePostgreSqlIntervalQualifierAttempt = (
  cursor: SqlTokenCursor,
): PostgreSqlIntervalQualifierParseAttempt => {
  const firstInspection = inspectSqlTokenCursor(
    cursor,
    0,
    "PostgreSQL interval qualifier first field inspection",
  );
  const firstWord = postgreSqlTokenWord(firstInspection.token);
  if (
    firstWord === null
    || !POSTGRESQL_INTERVAL_FIELDS.has(firstWord)
  ) {
    return {
      cursor: restoreSqlTokenCursorPosition(cursor, firstInspection.cursor),
      matched: false,
    };
  }
  const startIndex = cursor.index;
  let current = consumeSqlTokenCursor(
    firstInspection.cursor,
    "PostgreSQL interval qualifier first field",
  ).cursor;
  let endField = firstWord as SqlIntervalField;

  let nextInspection = inspectSqlTokenCursor(
    current,
    0,
    "PostgreSQL interval qualifier TO inspection",
  );
  current = nextInspection.cursor;
  if (postgreSqlTokenWord(nextInspection.token) === "to") {
    const toRange = sqlCursorRange(current);
    current = consumeSqlTokenCursor(
      current,
      "PostgreSQL interval qualifier TO",
    ).cursor;
    const secondInspection = inspectSqlTokenCursor(
      current,
      0,
      "PostgreSQL interval qualifier second field inspection",
    );
    current = secondInspection.cursor;
    const secondWord = postgreSqlTokenWord(secondInspection.token);
    if (
      secondWord === null
      || !POSTGRESQL_INTERVAL_FIELD_PAIRS.has(`${firstWord}:${secondWord}`)
    ) {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        `PostgreSQL does not allow INTERVAL ${firstWord.toUpperCase()} TO ${(secondWord ?? secondInspection.token?.text ?? "end of input").toUpperCase()}`,
        secondInspection.token?.range ?? toRange,
      );
    }
    endField = secondWord as SqlIntervalField;
    current = consumeSqlTokenCursor(
      current,
      "PostgreSQL interval qualifier second field",
    ).cursor;
    nextInspection = inspectSqlTokenCursor(
      current,
      0,
      "PostgreSQL interval qualifier precision inspection",
    );
    current = nextInspection.cursor;
  }

  let secondPrecision: string | null = null;
  if (nextInspection.token?.text === "(") {
    if (endField !== "second") {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        "Only the SECOND field may have precision in a PostgreSQL interval qualifier",
        sqlCursorRange(current),
      );
    }
    const precision = parsePostgreSqlIntegerModifier(
      current,
      "PostgreSQL interval SECOND precision",
    );
    secondPrecision = precision.modifier.normalizedValue;
    current = precision.cursor;
  }

  const range = sqlRangeFromTokenIndexes(
    cursor.kernel,
    startIndex,
    current.index,
  );
  return {
    cursor: current,
    matched: true,
    node: {
      endField,
      range,
      secondPrecision,
      sql: cursor.kernel.sql.slice(range.start, range.end),
      startField: firstWord as SqlIntervalField,
    },
  };
};

export const parsePostgreSqlIntervalQualifier = (
  cursor: SqlTokenCursor,
): SqlTypeParseResult<SqlIntervalQualifierNode> | null => {
  const attempt = parsePostgreSqlIntervalQualifierAttempt(cursor);
  return attempt.matched
    ? { cursor: attempt.cursor, node: attempt.node }
    : null;
};
