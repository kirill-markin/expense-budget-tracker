import type {
  SqlIdentifierToken,
  SqlSourceRange,
} from "./sql-policy-lexer.js";
import {
  isPostgreSqlColId as isColId,
  isPostgreSqlTypeFunctionName as isTypeFunctionName,
  POSTGRESQL_INTERVAL_FIELD_PAIRS as INTERVAL_FIELD_PAIRS,
  POSTGRESQL_INTERVAL_FIELDS as INTERVAL_FIELDS,
  postgreSqlTokenWord as tokenWord,
} from "./sql-policy-parser-keywords.js";
import {
  advanceSqlTokenCursor,
  createSqlParserKernel,
  createSqlTokenCursor,
  matchingSqlDelimiterIndexAtCursor,
  matchingSqlDelimiterIndexWithinCursor,
  sqlCursorRange,
  sqlRangeFromTokenIndexes,
  sqlTokenAt,
  type SqlParserKernel,
  type SqlParserLimits,
  type SqlTokenCursor,
} from "./sql-policy-parser-kernel.js";
import { throwSqlPolicyParserError } from "./sql-policy-parser-model.js";
import {
  isPostgreSqlStringConstant as isStringConstant,
  parsePostgreSqlIntegerModifier as parseIntegerModifier,
  parsePostgreSqlIntervalQualifier as parseIntervalQualifier,
  parsePostgreSqlTypeModifierList as parseModifierList,
  postgreSqlIntegerConstant,
} from "./sql-policy-type-modifiers.js";
import type {
  SqlArrayBoundNode,
  SqlIntervalQualifierNode,
  SqlTimeZoneNode,
  SqlTypedConstantNode,
  SqlTypeModifierNode,
  SqlTypeNameForm,
  SqlTypeNameNode,
  SqlTypeParseResult,
} from "./sql-policy-type-model.js";

export type {
  SqlArrayBoundNode,
  SqlIntervalQualifierNode,
  SqlTimeZoneNode,
  SqlTypedConstantNode,
  SqlTypeModifierNode,
  SqlTypeNameForm,
  SqlTypeNameNode,
  SqlTypeParseResult,
} from "./sql-policy-type-model.js";

type TypeNameContext = "typed_constant" | "typename";

type ParsedTypeBase = Readonly<{
  cursor: SqlTokenCursor;
  form: SqlTypeNameForm;
  intervalQualifier: SqlIntervalQualifierNode | null;
  modifiers: ReadonlyArray<SqlTypeModifierNode>;
  nameParts: ReadonlyArray<SqlIdentifierToken>;
  nameRange: SqlSourceRange;
  timeZone: SqlTimeZoneNode | null;
}>;

const isWord = (
  cursor: SqlTokenCursor,
  offset: number,
  expected: string,
): boolean => tokenWord(sqlTokenAt(cursor, offset)) === expected;

const isText = (
  cursor: SqlTokenCursor,
  offset: number,
  expected: string,
): boolean => sqlTokenAt(cursor, offset)?.text === expected;

const identifierAt = (
  cursor: SqlTokenCursor,
  offset: number,
): SqlIdentifierToken | null => {
  const token = sqlTokenAt(cursor, offset);
  return token?.kind === "identifier" ? token : null;
};

const parseGenericType = (
  cursor: SqlTokenCursor,
  context: TypeNameContext,
): ParsedTypeBase | null => {
  const first = identifierAt(cursor, 0);
  if (first === null) {
    return null;
  }
  const qualified = isText(cursor, 1, ".");
  if (
    context === "typed_constant"
    && qualified
    && !isColId(first)
  ) {
    const dot = sqlTokenAt(cursor, 1);
    if (dot === undefined) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        "Qualified PostgreSQL typed-constant type name lost its . token",
        sqlCursorRange(cursor),
      );
    }
    return throwSqlPolicyParserError(
      "invalid_typed_constant",
      `PostgreSQL qualified typed-constant type names require a ColId before .; ${first.text} is not a ColId`,
      dot.range,
    );
  }
  const firstAllowed = context === "typed_constant" && qualified
    ? true
    : isTypeFunctionName(first);
  if (!firstAllowed) {
    return null;
  }

  const nameStart = cursor.index;
  const nameParts: Array<SqlIdentifierToken> = [first];
  let current = advanceSqlTokenCursor(
    cursor,
    1,
    "PostgreSQL generic type name",
  );
  while (isText(current, 0, ".")) {
    const attribute = identifierAt(current, 1);
    if (attribute === null) {
      return throwSqlPolicyParserError(
        "invalid_type_name",
        "Expected a PostgreSQL identifier after . in a qualified type name",
        sqlTokenAt(current, 0)?.range ?? sqlCursorRange(current),
      );
    }
    nameParts.push(attribute);
    current = advanceSqlTokenCursor(
      current,
      2,
      "PostgreSQL qualified type name",
    );
  }
  const nameRange = sqlRangeFromTokenIndexes(
    cursor.kernel,
    nameStart,
    current.index,
  );

  let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
  if (isText(current, 0, "(")) {
    if (context === "typed_constant") {
      const closeIndex = matchingSqlDelimiterIndexAtCursor(current);
      if (
        closeIndex >= current.endIndex
        || !isStringConstant(
          sqlTokenAt(
            current,
            closeIndex - current.index + 1,
          ),
        )
      ) {
        return null;
      }
    }
    const parsed = parseModifierList(current);
    modifiers = parsed.modifiers;
    current = parsed.cursor;
  }
  return {
    cursor: current,
    form: "generic",
    intervalQualifier: null,
    modifiers,
    nameParts,
    nameRange,
    timeZone: null,
  };
};

const parseTimeZone = (
  cursor: SqlTokenCursor,
): Readonly<{
  cursor: SqlTokenCursor;
  node: SqlTimeZoneNode | null;
}> => {
  const firstWord = tokenWord(sqlTokenAt(cursor, 0));
  const secondWord = tokenWord(sqlTokenAt(cursor, 1));
  const hasLookaheadToken =
    (
      firstWord === "with"
      && (secondWord === "time" || secondWord === "ordinality")
    )
    || (firstWord === "without" && secondWord === "time");
  if (!hasLookaheadToken) {
    return { cursor, node: null };
  }
  if (
    secondWord !== "time"
    || !isWord(cursor, 2, "zone")
  ) {
    const unexpectedOffset = secondWord === "time" ? 2 : 1;
    return throwSqlPolicyParserError(
      "invalid_type_name",
      `Expected TIME ZONE after ${firstWord.toUpperCase()} in a PostgreSQL datetime type`,
      sqlTokenAt(cursor, unexpectedOffset)?.range ?? sqlCursorRange(cursor),
    );
  }
  const range = sqlRangeFromTokenIndexes(
    cursor.kernel,
    cursor.index,
    cursor.index + 3,
  );
  return {
    cursor: advanceSqlTokenCursor(
      cursor,
      3,
      "PostgreSQL datetime time zone",
    ),
    node: { kind: firstWord, range },
  };
};

const typeBase = (
  cursor: SqlTokenCursor,
  form: SqlTypeNameForm,
  nameParts: ReadonlyArray<SqlIdentifierToken>,
  nameStart: number,
  modifiers: ReadonlyArray<SqlTypeModifierNode>,
  intervalQualifier: SqlIntervalQualifierNode | null,
  timeZone: SqlTimeZoneNode | null,
): ParsedTypeBase => ({
  cursor,
  form,
  intervalQualifier,
  modifiers,
  nameParts,
  nameRange: sqlRangeFromTokenIndexes(
    cursor.kernel,
    nameStart,
    nameStart + nameParts.length,
  ),
  timeZone,
});

const simpleTypeForm = (
  word: string,
): SqlTypeNameForm | null => {
  switch (word) {
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "int":
    case "integer":
      return "integer";
    case "json":
      return "json";
    case "real":
      return "real";
    case "smallint":
      return "smallint";
    default:
      return null;
  }
};

const parseSpecialType = (
  cursor: SqlTokenCursor,
  context: TypeNameContext,
): ParsedTypeBase | null => {
  const first = identifierAt(cursor, 0);
  const word = tokenWord(first ?? undefined);
  if (first === null || word === null || isText(cursor, 1, ".")) {
    return null;
  }
  const nameStart = cursor.index;

  const form = simpleTypeForm(word);
  if (form !== null) {
    const current = advanceSqlTokenCursor(
      cursor,
      1,
      `PostgreSQL ${word} type`,
    );
    if (isText(current, 0, "(")) {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        `PostgreSQL type ${word.toUpperCase()} does not allow type modifiers`,
        sqlCursorRange(current),
      );
    }
    return typeBase(
      current,
      form,
      [first],
      nameStart,
      [],
      null,
      null,
    );
  }

  if (word === "float") {
    let current = advanceSqlTokenCursor(cursor, 1, "PostgreSQL FLOAT type");
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    if (isText(current, 0, "(")) {
      const precision = parseIntegerModifier(
        current,
        "PostgreSQL FLOAT precision",
      );
      if (precision.value < 1n || precision.value > 53n) {
        return throwSqlPolicyParserError(
          "invalid_type_modifier",
          `PostgreSQL FLOAT precision must be between 1 and 53; received ${String(precision.value)}`,
          precision.modifier.range,
        );
      }
      modifiers = [precision.modifier];
      current = precision.cursor;
    }
    return typeBase(
      current,
      "float",
      [first],
      nameStart,
      modifiers,
      null,
      null,
    );
  }

  if (word === "double" && isWord(cursor, 1, "precision")) {
    const precision = identifierAt(cursor, 1);
    if (precision === null) {
      return throwSqlPolicyParserError(
        "internal_invariant",
        "PostgreSQL PRECISION token is not an identifier",
        sqlCursorRange(cursor),
      );
    }
    const current = advanceSqlTokenCursor(
      cursor,
      2,
      "PostgreSQL DOUBLE PRECISION type",
    );
    if (isText(current, 0, "(")) {
      return throwSqlPolicyParserError(
        "invalid_type_modifier",
        "PostgreSQL type DOUBLE PRECISION does not allow type modifiers",
        sqlCursorRange(current),
      );
    }
    return typeBase(
      current,
      "double_precision",
      [first, precision],
      nameStart,
      [],
      null,
      null,
    );
  }

  if (word === "decimal" || word === "dec" || word === "numeric") {
    let current = advanceSqlTokenCursor(
      cursor,
      1,
      `PostgreSQL ${word} type`,
    );
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    if (isText(current, 0, "(")) {
      const parsed = parseModifierList(current);
      modifiers = parsed.modifiers;
      current = parsed.cursor;
    }
    return typeBase(
      current,
      "decimal",
      [first],
      nameStart,
      modifiers,
      null,
      null,
    );
  }

  if (word === "bit") {
    const nameParts: Array<SqlIdentifierToken> = [first];
    let current = advanceSqlTokenCursor(cursor, 1, "PostgreSQL BIT type");
    if (isWord(current, 0, "varying")) {
      const varying = identifierAt(current, 0);
      if (varying !== null) {
        nameParts.push(varying);
      }
      current = advanceSqlTokenCursor(
        current,
        1,
        "PostgreSQL BIT VARYING type",
      );
    }
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    if (isText(current, 0, "(")) {
      const parsed = parseModifierList(current);
      modifiers = parsed.modifiers;
      current = parsed.cursor;
    }
    return typeBase(
      current,
      "bit",
      nameParts,
      nameStart,
      modifiers,
      null,
      null,
    );
  }

  if (
    word === "char"
    || word === "character"
    || word === "varchar"
    || word === "nchar"
    || word === "national"
  ) {
    const nameParts: Array<SqlIdentifierToken> = [first];
    let current = advanceSqlTokenCursor(
      cursor,
      1,
      "PostgreSQL character type",
    );
    if (word === "national") {
      if (!isWord(current, 0, "char") && !isWord(current, 0, "character")) {
        return null;
      }
      const nationalKind = identifierAt(current, 0);
      if (nationalKind !== null) {
        nameParts.push(nationalKind);
      }
      current = advanceSqlTokenCursor(
        current,
        1,
        "PostgreSQL national character type",
      );
    }
    if (
      word !== "varchar"
      && isWord(current, 0, "varying")
    ) {
      const varying = identifierAt(current, 0);
      if (varying !== null) {
        nameParts.push(varying);
      }
      current = advanceSqlTokenCursor(
        current,
        1,
        "PostgreSQL varying character type",
      );
    }
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    if (isText(current, 0, "(")) {
      const length = parseIntegerModifier(
        current,
        "PostgreSQL character length",
      );
      modifiers = [length.modifier];
      current = length.cursor;
    }
    return typeBase(
      current,
      "character",
      nameParts,
      nameStart,
      modifiers,
      null,
      null,
    );
  }

  if (word === "time" || word === "timestamp") {
    let current = advanceSqlTokenCursor(
      cursor,
      1,
      `PostgreSQL ${word} type`,
    );
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    if (isText(current, 0, "(")) {
      const precision = parseIntegerModifier(
        current,
        `PostgreSQL ${word.toUpperCase()} precision`,
      );
      modifiers = [precision.modifier];
      current = precision.cursor;
    }
    const timeZone = parseTimeZone(current);
    current = timeZone.cursor;
    return typeBase(
      current,
      word,
      [first],
      nameStart,
      modifiers,
      null,
      timeZone.node,
    );
  }

  if (word === "interval") {
    let current = advanceSqlTokenCursor(
      cursor,
      1,
      "PostgreSQL INTERVAL type",
    );
    let modifiers: ReadonlyArray<SqlTypeModifierNode> = [];
    let qualifier: SqlIntervalQualifierNode | null = null;
    if (isText(current, 0, "(")) {
      const precision = parseIntegerModifier(
        current,
        "PostgreSQL INTERVAL leading precision",
      );
      modifiers = [precision.modifier];
      current = precision.cursor;
      const followingField = tokenWord(sqlTokenAt(current, 0));
      if (
        followingField !== null
        && INTERVAL_FIELDS.has(followingField)
      ) {
        return throwSqlPolicyParserError(
          "invalid_type_modifier",
          "PostgreSQL INTERVAL leading precision cannot be combined with an interval field qualifier",
          sqlCursorRange(current),
        );
      }
    } else if (context === "typename") {
      const parsedQualifier = parseIntervalQualifier(current);
      if (parsedQualifier !== null) {
        qualifier = parsedQualifier.node;
        current = parsedQualifier.cursor;
      }
    }
    return typeBase(
      current,
      "interval",
      [first],
      nameStart,
      modifiers,
      qualifier,
      null,
    );
  }

  return null;
};

const parseArrayBounds = (
  cursor: SqlTokenCursor,
): Readonly<{
  bounds: ReadonlyArray<SqlArrayBoundNode>;
  cursor: SqlTokenCursor;
}> => {
  const bounds: Array<SqlArrayBoundNode> = [];
  let current = cursor;

  while (isText(current, 0, "[")) {
    const startIndex = current.index;
    const closeIndex = matchingSqlDelimiterIndexWithinCursor(
      current,
      "invalid_type_name",
      "PostgreSQL bracket array bound",
    );
    if (
      closeIndex !== startIndex + 1
      && closeIndex !== startIndex + 2
    ) {
      return throwSqlPolicyParserError(
        "invalid_type_name",
        "PostgreSQL [] array bounds may contain at most one integer constant",
        sqlCursorRange(current),
      );
    }
    let size: string | null = null;
    if (closeIndex === startIndex + 2) {
      const valueToken = sqlTokenAt(current, 1);
      const integerConstant = postgreSqlIntegerConstant(valueToken);
      if (integerConstant === null) {
        return throwSqlPolicyParserError(
          "invalid_type_name",
          "PostgreSQL array bounds require an integer constant between 0 and 2147483647",
          valueToken?.range ?? sqlCursorRange(current),
        );
      }
      size = integerConstant.semanticValue;
    }
    const range = sqlRangeFromTokenIndexes(
      current.kernel,
      startIndex,
      closeIndex + 1,
    );
    bounds.push({ notation: "brackets", range, size });
    current = advanceSqlTokenCursor(
      current,
      closeIndex - startIndex + 1,
      "PostgreSQL bracket array bound",
    );
  }

  if (isWord(current, 0, "array")) {
    if (bounds.length > 0) {
      return throwSqlPolicyParserError(
        "invalid_type_name",
        "PostgreSQL Typename cannot combine [] array bounds with ARRAY syntax",
        sqlCursorRange(current),
      );
    }
    const startIndex = current.index;
    current = advanceSqlTokenCursor(
      current,
      1,
      "PostgreSQL ARRAY type decoration",
    );
    let size: string | null = null;
    if (isText(current, 0, "[")) {
      const closeIndex = matchingSqlDelimiterIndexWithinCursor(
        current,
        "invalid_type_name",
        "PostgreSQL sized ARRAY type decoration",
      );
      const valueToken = sqlTokenAt(current, 1);
      const integerConstant = postgreSqlIntegerConstant(valueToken);
      if (
        closeIndex !== current.index + 2
        || integerConstant === null
      ) {
        return throwSqlPolicyParserError(
          "invalid_type_name",
          "PostgreSQL ARRAY[n] requires exactly one integer constant between 0 and 2147483647",
          valueToken?.range ?? sqlCursorRange(current),
        );
      }
      size = integerConstant.semanticValue;
      current = advanceSqlTokenCursor(
        current,
        3,
        "PostgreSQL sized ARRAY type decoration",
      );
    }
    const range = sqlRangeFromTokenIndexes(
      current.kernel,
      startIndex,
      current.index,
    );
    bounds.push({ notation: "array", range, size });
    if (isText(current, 0, "[") || isWord(current, 0, "array")) {
      return throwSqlPolicyParserError(
        "invalid_type_name",
        "PostgreSQL ARRAY type syntax is one-dimensional and cannot be followed by another array decoration",
        sqlCursorRange(current),
      );
    }
  }
  return { bounds, cursor: current };
};

export const parsePostgreSqlTypeNameAtCursor = (
  cursor: SqlTokenCursor,
  context: TypeNameContext,
): SqlTypeParseResult<SqlTypeNameNode> | null => {
  const startIndex = cursor.index;
  let current = cursor;
  let setOf = false;
  if (context === "typename" && isWord(current, 0, "setof")) {
    setOf = true;
    current = advanceSqlTokenCursor(
      current,
      1,
      "PostgreSQL SETOF type",
    );
  }

  const special = parseSpecialType(current, context);
  const base = special ?? parseGenericType(current, context);
  if (base === null) {
    return null;
  }
  current = base.cursor;

  let arrayBounds: ReadonlyArray<SqlArrayBoundNode> = [];
  if (context === "typename") {
    const arrays = parseArrayBounds(current);
    arrayBounds = arrays.bounds;
    current = arrays.cursor;
  }

  const range = sqlRangeFromTokenIndexes(
    cursor.kernel,
    startIndex,
    current.index,
  );
  return {
    cursor: current,
    node: {
      arrayBounds,
      form: base.form,
      intervalQualifier: base.intervalQualifier,
      modifiers: base.modifiers,
      nameParts: base.nameParts,
      nameRange: base.nameRange,
      range,
      setOf,
      sql: cursor.kernel.sql.slice(range.start, range.end),
      timeZone: base.timeZone,
    },
  };
};

export const parsePostgreSqlTypedConstantAtCursor = (
  cursor: SqlTokenCursor,
): SqlTypeParseResult<SqlTypedConstantNode> | null => {
  const parsedType = parsePostgreSqlTypeNameAtCursor(
    cursor,
    "typed_constant",
  );
  if (parsedType === null) {
    return null;
  }
  const value = sqlTokenAt(parsedType.cursor, 0);
  if (!isStringConstant(value)) {
    return null;
  }
  let current = advanceSqlTokenCursor(
    parsedType.cursor,
    1,
    "PostgreSQL typed constant value",
  );
  let qualifier: SqlIntervalQualifierNode | null = null;
  if (parsedType.node.form === "interval") {
    if (parsedType.node.modifiers.length > 0) {
      const following = tokenWord(sqlTokenAt(current, 0));
      if (following !== null && INTERVAL_FIELDS.has(following)) {
        return throwSqlPolicyParserError(
          "invalid_typed_constant",
          "PostgreSQL INTERVAL leading precision typed constants cannot have a postfix field qualifier",
          sqlCursorRange(current),
        );
      }
    } else {
      const parsedQualifier = parseIntervalQualifier(current);
      if (parsedQualifier !== null) {
        qualifier = parsedQualifier.node;
        current = parsedQualifier.cursor;
      }
    }
  }
  const range = sqlRangeFromTokenIndexes(
    cursor.kernel,
    cursor.index,
    current.index,
  );
  return {
    cursor: current,
    node: {
      intervalQualifier: qualifier,
      range,
      sql: cursor.kernel.sql.slice(range.start, range.end),
      typeName: parsedType.node,
      value,
    },
  };
};

const directFragmentCursor = (
  kernel: SqlParserKernel,
  subject: string,
): SqlTokenCursor => {
  const statement = kernel.statements[0];
  if (
    statement === undefined
    || kernel.statements.length !== 1
    || statement.startIndex !== 0
    || statement.endIndex !== kernel.tokens.length
    || statement.terminatorRange !== null
  ) {
    const unexpected = kernel.statements[1]?.range
      ?? statement?.terminatorRange
      ?? kernel.tokens[0]?.range
      ?? { start: 0, end: 0 };
    return throwSqlPolicyParserError(
      "unexpected_token",
      `${subject} requires exactly one non-empty SQL fragment without a statement terminator`,
      unexpected,
    );
  }
  return createSqlTokenCursor(
    kernel,
    statement.startIndex,
    statement.endIndex,
  );
};

const assertFullyConsumed = (
  result: SqlTypeParseResult<SqlTypeNameNode | SqlTypedConstantNode>,
  subject: string,
): void => {
  if (result.cursor.index === result.cursor.endIndex) {
    return;
  }
  const token = sqlTokenAt(result.cursor, 0);
  return throwSqlPolicyParserError(
    "unexpected_token",
    `Unexpected token ${token?.text ?? "at end of input"} after ${subject}`,
    token?.range ?? sqlCursorRange(result.cursor),
  );
};

export const parsePostgreSqlTypeNameInfrastructure = (
  sql: string,
  limits: SqlParserLimits,
): SqlTypeNameNode => {
  const kernel = createSqlParserKernel(sql, limits);
  const cursor = directFragmentCursor(kernel, "PostgreSQL Typename parsing");
  const result = parsePostgreSqlTypeNameAtCursor(cursor, "typename");
  if (result === null) {
    return throwSqlPolicyParserError(
      "invalid_type_name",
      "Expected a PostgreSQL 18 Typename",
      sqlCursorRange(cursor),
    );
  }
  assertFullyConsumed(result, "PostgreSQL Typename");
  return result.node;
};

export const parsePostgreSqlTypedConstantInfrastructure = (
  sql: string,
  limits: SqlParserLimits,
): SqlTypedConstantNode => {
  const kernel = createSqlParserKernel(sql, limits);
  const cursor = directFragmentCursor(
    kernel,
    "PostgreSQL typed-constant parsing",
  );
  const result = parsePostgreSqlTypedConstantAtCursor(cursor);
  if (result === null) {
    return throwSqlPolicyParserError(
      "invalid_typed_constant",
      "Expected a complete PostgreSQL 18 typed constant",
      sqlCursorRange(cursor),
    );
  }
  assertFullyConsumed(result, "PostgreSQL typed constant");
  return result.node;
};
