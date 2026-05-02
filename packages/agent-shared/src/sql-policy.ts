/**
 * Shared SQL policy for machine-facing database access.
 */
export const MAX_SQL_ROWS = 100;
export const SQL_STATEMENT_TIMEOUT_MS = 30_000;

export const ALLOWED_SQL_FUNCTION_NAMES = [
  "sum",
  "count",
  "min",
  "max",
  "avg",
  "coalesce",
] as const;

export type AllowedSqlFunctionName = typeof ALLOWED_SQL_FUNCTION_NAMES[number];

const ALLOWED_SQL_FUNCTIONS: ReadonlySet<string> = new Set(ALLOWED_SQL_FUNCTION_NAMES);

const ALLOWED_SQL_FUNCTIONS_DESCRIPTION = ALLOWED_SQL_FUNCTION_NAMES
  .map((name) => name.toUpperCase())
  .join(", ");

const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
]);

const SOURCE_CLAUSE_END: ReadonlySet<string> = new Set([
  "where",
  "group",
  "order",
  "limit",
  "offset",
  "fetch",
  "union",
  "except",
  "intersect",
  "returning",
  "having",
  "window",
]);

const ALLOWED_RELATION_NAMES = [
  "ledger_entries",
  "accounts",
  "budget_lines",
  "budget_comments",
  "workspace_settings",
  "account_metadata",
  "fx_rates_raw",
  "fx_rates_daily",
] as const;

export type AllowedRelationName = typeof ALLOWED_RELATION_NAMES[number];

const ALLOWED_RELATIONS: ReadonlySet<string> = new Set(ALLOWED_RELATION_NAMES);

type SqlToken = Readonly<{
  kind: "word" | "punct";
  value: string;
  lower: string;
}>;

type RelationReference = Readonly<{
  relationName: string;
  nextIndex: number;
  isQualified: boolean;
}>;

type CteDefinition = Readonly<{
  name: string;
  bodyStartIndex: number;
  bodyEndIndex: number;
}>;

type SqlPolicyErrorCode =
  | "unsupported_statement"
  | "on_conflict_not_allowed"
  | "set_config_not_allowed"
  | "function_calls_not_allowed"
  | "sql_comments_not_allowed"
  | "quoted_identifiers_not_allowed"
  | "dollar_quoted_strings_not_allowed"
  | "unterminated_string_literal"
  | "invalid_relation_reference"
  | "relation_not_allowed";

export class SqlPolicyError extends Error {
  readonly code: SqlPolicyErrorCode;

  constructor(code: SqlPolicyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ValidatedExpenseSql = Readonly<{
  sql: string;
  statements: ReadonlyArray<ValidatedExpenseSqlStatement>;
}>;

export type RestrictedSqlResultRow = Readonly<Record<string, unknown>>;

export type RestrictedSqlQueryResult = Readonly<{
  command: string;
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number | null;
}>;

export type ValidatedExpenseSqlStatement = Readonly<{
  sql: string;
  isMutating: boolean;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

export type ExecutedExpenseSqlStatement = Readonly<{
  sql: string;
  command: string;
  isMutating: boolean;
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

export type ExecutedExpenseSql = Readonly<{
  sql: string;
  statements: ReadonlyArray<ExecutedExpenseSqlStatement>;
}>;

const fail = (code: SqlPolicyErrorCode, message: string): never => {
  throw new SqlPolicyError(code, message);
};

const getFirstKeyword = (sql: string): string | undefined =>
  sql.trimStart().split(/\s/u)[0]?.toUpperCase();

const isWordStart = (value: string): boolean => /[A-Za-z_]/u.test(value);

const isWordPart = (value: string): boolean => /[A-Za-z0-9_]/u.test(value);

const readDollarQuoteTag = (
  sql: string,
  startIndex: number,
): Readonly<{
  tag: string;
  nextIndex: number;
}> | null => {
  if (sql[startIndex] !== "$") {
    return null;
  }

  const next = sql[startIndex + 1];
  if (next === "$") {
    return {
      tag: "$$",
      nextIndex: startIndex + 2,
    };
  }

  if (next === undefined || !isWordStart(next)) {
    return null;
  }

  let index = startIndex + 2;
  while (index < sql.length && isWordPart(sql[index])) {
    index++;
  }

  if (sql[index] !== "$") {
    return null;
  }

  return {
    tag: sql.slice(startIndex, index + 1),
    nextIndex: index + 1,
  };
};

const splitSqlStatements = (sql: string): ReadonlyArray<string> => {
  const statements: Array<string> = [];
  let statementStartIndex = 0;
  let index = 0;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | null = null;
  let state:
    | "plain"
    | "single_quote"
    | "double_quote"
    | "line_comment"
    | "block_comment"
    | "dollar_quote" = "plain";

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (state === "single_quote") {
      if (current === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (current === "'") {
        state = "plain";
      }
      index++;
      continue;
    }

    if (state === "double_quote") {
      if (current === "\"" && next === "\"") {
        index += 2;
        continue;
      }
      if (current === "\"") {
        state = "plain";
      }
      index++;
      continue;
    }

    if (state === "line_comment") {
      if (current === "\n") {
        state = "plain";
      }
      index++;
      continue;
    }

    if (state === "block_comment") {
      if (current === "/" && next === "*") {
        blockCommentDepth++;
        index += 2;
        continue;
      }
      if (current === "*" && next === "/") {
        blockCommentDepth--;
        index += 2;
        if (blockCommentDepth === 0) {
          state = "plain";
        }
        continue;
      }
      index++;
      continue;
    }

    if (state === "dollar_quote") {
      if (dollarQuoteTag !== null && sql.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length;
        state = "plain";
        dollarQuoteTag = null;
        continue;
      }
      index++;
      continue;
    }

    if (current === "'") {
      state = "single_quote";
      index++;
      continue;
    }

    if (current === "\"") {
      state = "double_quote";
      index++;
      continue;
    }

    if (current === "-" && next === "-") {
      state = "line_comment";
      index += 2;
      continue;
    }

    if (current === "/" && next === "*") {
      state = "block_comment";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    const dollarQuote = readDollarQuoteTag(sql, index);
    if (dollarQuote !== null) {
      state = "dollar_quote";
      dollarQuoteTag = dollarQuote.tag;
      index = dollarQuote.nextIndex;
      continue;
    }

    if (current === ";") {
      const statement = sql.slice(statementStartIndex, index).trim();
      if (statement !== "") {
        statements.push(statement);
      }
      statementStartIndex = index + 1;
    }

    index++;
  }

  const finalStatement = sql.slice(statementStartIndex).trim();
  if (finalStatement !== "") {
    statements.push(finalStatement);
  }

  return statements;
};

const containsSetConfig = (sql: string): boolean => /\bset_config\b/iu.test(sql);

const containsOnConflict = (sql: string): boolean => /\bon\s+conflict\b/iu.test(sql);

const assertSupportedSqlSyntax = (sql: string): void => {
  if (sql.includes("--") || sql.includes("/*")) {
    fail("sql_comments_not_allowed", "SQL comments are not allowed");
  }
  if (sql.includes("\"")) {
    fail("quoted_identifiers_not_allowed", "Quoted identifiers are not allowed");
  }
  if (/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/u.test(sql)) {
    fail("dollar_quoted_strings_not_allowed", "Dollar-quoted strings are not allowed");
  }
};

const stripSingleQuotedStrings = (sql: string): string => {
  let result = "";
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inString) {
      if (ch === "'") {
        inString = true;
        result += " ";
      } else {
        result += ch;
      }
      continue;
    }

    if (ch === "'" && i + 1 < sql.length && sql[i + 1] === "'") {
      result += "  ";
      i++;
      continue;
    }

    if (ch === "'") {
      inString = false;
      result += " ";
      continue;
    }

    result += " ";
  }

  if (inString) {
    fail("unterminated_string_literal", "Unterminated SQL string literal");
  }

  return result;
};

const tokenizeSql = (sql: string): ReadonlyArray<SqlToken> => {
  const tokens: Array<SqlToken> = [];

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (/\s/u.test(ch)) {
      continue;
    }

    if (/[A-Za-z_]/u.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/u.test(sql[j])) {
        j++;
      }
      const value = sql.slice(i, j);
      tokens.push({ kind: "word", value, lower: value.toLowerCase() });
      i = j - 1;
      continue;
    }

    tokens.push({ kind: "punct", value: ch, lower: ch });
  }

  return tokens;
};

const findMatchingParen = (
  tokens: ReadonlyArray<SqlToken>,
  openIndex: number,
  endIndex: number,
): number => {
  if (tokens[openIndex]?.value !== "(") {
    fail("invalid_relation_reference", "Expected opening parenthesis");
  }

  let depth = 1;
  for (let i = openIndex + 1; i < endIndex; i++) {
    const token = tokens[i];
    if (token?.value === "(") {
      depth++;
      continue;
    }
    if (token?.value === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return fail("invalid_relation_reference", "Expected closing parenthesis");
};

const findPreviousSignificantIndex = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
): number | null => {
  for (let index = startIndex; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token !== undefined) {
      return index;
    }
  }
  return null;
};

const parseRelationName = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
): RelationReference => {
  const first = tokens[startIndex];
  if (first === undefined || first.kind !== "word") {
    fail("invalid_relation_reference", "Expected a relation name after the SQL clause");
  }

  const dot = tokens[startIndex + 1];
  const second = tokens[startIndex + 2];

  if (dot?.value === ".") {
    if (first.lower !== "public" || second?.kind !== "word") {
      fail("relation_not_allowed", `Relation ${first.value}.${second?.value ?? ""} is not allowed`);
    }
    return {
      relationName: second.lower,
      nextIndex: startIndex + 3,
      isQualified: true,
    };
  }

  return {
    relationName: first.lower,
    nextIndex: startIndex + 1,
    isQualified: false,
  };
};

const asAllowedRelationName = (value: string): AllowedRelationName => value as AllowedRelationName;

const collectRelationReference = (
  reference: RelationReference,
  visibleCteNames: ReadonlySet<string>,
  relations: Set<AllowedRelationName>,
): void => {
  if (reference.isQualified) {
    if (!ALLOWED_RELATIONS.has(reference.relationName)) {
      fail("relation_not_allowed", `Relation ${reference.relationName} is not allowed`);
    }
    relations.add(asAllowedRelationName(reference.relationName));
    return;
  }

  if (visibleCteNames.has(reference.relationName)) {
    return;
  }

  if (!ALLOWED_RELATIONS.has(reference.relationName)) {
    fail("relation_not_allowed", `Relation ${reference.relationName} is not allowed`);
  }

  relations.add(asAllowedRelationName(reference.relationName));
};

const mergeRelations = (
  target: Set<AllowedRelationName>,
  source: ReadonlyArray<AllowedRelationName>,
): void => {
  for (const relation of source) {
    target.add(relation);
  }
};

const collectReferencedRelationsFromSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
  visibleCteNames: ReadonlySet<string>,
): ReadonlyArray<AllowedRelationName> => {
  if (startIndex >= endIndex) {
    return [];
  }

  if (tokens[startIndex]?.lower === "with") {
    return collectReferencedRelationsFromWithClause(tokens, startIndex, endIndex, visibleCteNames);
  }

  const relations = new Set<AllowedRelationName>();
  let inSourceClause = false;
  let expectRelation = false;

  for (let i = startIndex; i < endIndex; i++) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }

    if (token.kind === "punct") {
      if (token.value === "(") {
        if (inSourceClause && expectRelation) {
          expectRelation = false;
        }
        const closeIndex = findMatchingParen(tokens, i, endIndex);
        mergeRelations(
          relations,
          collectReferencedRelationsFromSegment(tokens, i + 1, closeIndex, visibleCteNames),
        );
        i = closeIndex;
        continue;
      }

      if (inSourceClause && token.value === ",") {
        expectRelation = true;
        continue;
      }
      continue;
    }

    if (token.lower === "update" || token.lower === "into") {
      const reference = parseRelationName(tokens, i + 1);
      if (!ALLOWED_RELATIONS.has(reference.relationName)) {
        fail("relation_not_allowed", `Relation ${reference.relationName} is not allowed`);
      }
      relations.add(asAllowedRelationName(reference.relationName));
      continue;
    }

    if (token.lower === "delete" && tokens[i + 1]?.lower === "from") {
      const reference = parseRelationName(tokens, i + 2);
      if (!ALLOWED_RELATIONS.has(reference.relationName)) {
        fail("relation_not_allowed", `Relation ${reference.relationName} is not allowed`);
      }
      relations.add(asAllowedRelationName(reference.relationName));
      continue;
    }

    if (token.lower === "table") {
      fail("unsupported_statement", "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed");
    }

    if (token.lower === "from") {
      inSourceClause = true;
      expectRelation = true;
      continue;
    }

    if (inSourceClause && SOURCE_CLAUSE_END.has(token.lower)) {
      inSourceClause = false;
      expectRelation = false;
      continue;
    }

    if (inSourceClause && token.lower === "join") {
      expectRelation = true;
      continue;
    }

    if (!inSourceClause || !expectRelation) {
      continue;
    }

    const reference = parseRelationName(tokens, i);
    collectRelationReference(reference, visibleCteNames, relations);
    expectRelation = false;
    i = reference.nextIndex - 1;
  }

  return Array.from(relations);
};

const parseCteDefinitions = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): Readonly<{
  ctes: ReadonlyArray<CteDefinition>;
  mainQueryStartIndex: number;
  isRecursive: boolean;
}> => {
  let index = startIndex + 1;
  const isRecursive = tokens[index]?.lower === "recursive";
  if (isRecursive) {
    index++;
  }

  const ctes: Array<CteDefinition> = [];

  while (index < endIndex) {
    const nameToken = tokens[index];
    if (nameToken === undefined || nameToken.kind !== "word") {
      fail("invalid_relation_reference", "Expected a CTE name after WITH");
    }
    const name = nameToken.lower;
    index++;

    if (tokens[index]?.value === "(") {
      index = findMatchingParen(tokens, index, endIndex) + 1;
    }

    if (tokens[index]?.lower !== "as" || tokens[index + 1]?.value !== "(") {
      fail("invalid_relation_reference", `Expected AS (...) for CTE ${name}`);
    }

    const bodyOpenIndex = index + 1;
    const bodyCloseIndex = findMatchingParen(tokens, bodyOpenIndex, endIndex);
    ctes.push({
      name,
      bodyStartIndex: bodyOpenIndex + 1,
      bodyEndIndex: bodyCloseIndex,
    });

    index = bodyCloseIndex + 1;
    if (tokens[index]?.value === ",") {
      index++;
      continue;
    }
    break;
  }

  return {
    ctes,
    mainQueryStartIndex: index,
    isRecursive,
  };
};

const failFunctionCallNotAllowed = (functionName: string): never =>
  fail(
    "function_calls_not_allowed",
    `Function ${functionName}() is not allowed in restricted SQL. Allowed functions: ${ALLOWED_SQL_FUNCTIONS_DESCRIPTION}`,
  );

const assertOnlyAllowedFunctionCallsInSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): void => {
  if (startIndex >= endIndex) {
    return;
  }

  if (tokens[startIndex]?.lower === "with") {
    const { ctes, mainQueryStartIndex } = parseCteDefinitions(tokens, startIndex, endIndex);
    for (const cte of ctes) {
      assertOnlyAllowedFunctionCallsInSegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex);
    }
    assertOnlyAllowedFunctionCallsInSegment(tokens, mainQueryStartIndex, endIndex);
    return;
  }

  for (let index = startIndex; index < endIndex; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }

    if (token.lower === "into") {
      const reference = parseRelationName(tokens, index + 1);
      index = reference.nextIndex - 1;
      if (tokens[reference.nextIndex]?.value === "(") {
        index = findMatchingParen(tokens, reference.nextIndex, endIndex);
      }
      continue;
    }

    if (token.kind === "punct") {
      if (token.value === "(") {
        const closeIndex = findMatchingParen(tokens, index, endIndex);
        assertOnlyAllowedFunctionCallsInSegment(tokens, index + 1, closeIndex);
        index = closeIndex;
      }
      continue;
    }

    if (tokens[index + 1]?.value !== "(") {
      continue;
    }

    if (token.lower === "in" || token.lower === "exists" || token.lower === "values") {
      const closeIndex = findMatchingParen(tokens, index + 1, endIndex);
      assertOnlyAllowedFunctionCallsInSegment(tokens, index + 2, closeIndex);
      index = closeIndex;
      continue;
    }

    const previousIndex = findPreviousSignificantIndex(tokens, index - 1);
    const previousToken = previousIndex === null ? undefined : tokens[previousIndex];
    if (
      previousIndex !== null
      && previousToken?.value === "."
      && previousIndex >= 2
      && tokens[previousIndex - 1]?.lower === "public"
      && tokens[previousIndex - 2]?.lower === "into"
    ) {
      continue;
    }

    if (previousToken?.value === ".") {
      failFunctionCallNotAllowed(token.value);
    }

    if (!ALLOWED_SQL_FUNCTIONS.has(token.lower)) {
      failFunctionCallNotAllowed(token.value);
    }

    const closeIndex = findMatchingParen(tokens, index + 1, endIndex);
    assertOnlyAllowedFunctionCallsInSegment(tokens, index + 2, closeIndex);
    index = closeIndex;
  }
};

const collectReferencedRelationsFromWithClause = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
  outerVisibleCteNames: ReadonlySet<string>,
): ReadonlyArray<AllowedRelationName> => {
  const { ctes, mainQueryStartIndex, isRecursive } = parseCteDefinitions(tokens, startIndex, endIndex);
  const relations = new Set<AllowedRelationName>();
  const visibleCteNames = new Set<string>(outerVisibleCteNames);

  for (const cte of ctes) {
    const visibleNamesForBody = new Set<string>(visibleCteNames);
    if (isRecursive) {
      visibleNamesForBody.add(cte.name);
    }

    mergeRelations(
      relations,
      collectReferencedRelationsFromSegment(
        tokens,
        cte.bodyStartIndex,
        cte.bodyEndIndex,
        visibleNamesForBody,
      ),
    );

    visibleCteNames.add(cte.name);
  }

  mergeRelations(
    relations,
    collectReferencedRelationsFromSegment(tokens, mainQueryStartIndex, endIndex, visibleCteNames),
  );

  return Array.from(relations);
};

const collectReferencedRelations = (sql: string): ReadonlyArray<AllowedRelationName> => {
  assertSupportedSqlSyntax(sql);
  const sanitizedSql = stripSingleQuotedStrings(sql);
  if (containsOnConflict(sanitizedSql)) {
    fail("on_conflict_not_allowed", "ON CONFLICT is not supported in restricted SQL");
  }
  const tokens = tokenizeSql(sanitizedSql);
  return collectReferencedRelationsFromSegment(tokens, 0, tokens.length, new Set<string>());
};

/**
 * Classifies whether a validated SQL statement mutates persisted data.
 *
 * PostgreSQL command tags are not sufficient for this because a statement such
 * as `WITH changed AS (UPDATE ... RETURNING ...) SELECT ...` mutates data while
 * still reporting `SELECT` as the outer command. We therefore classify writes
 * from the validated SQL structure itself and carry that explicit flag through
 * downstream chat/runtime code.
 */
const statementMutatesDataFromSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): boolean => {
  if (startIndex >= endIndex) {
    return false;
  }

  const firstToken = tokens[startIndex];
  if (firstToken === undefined || firstToken.kind !== "word") {
    return false;
  }

  if (
    firstToken.lower === "insert"
    || firstToken.lower === "update"
    || firstToken.lower === "delete"
  ) {
    return true;
  }

  if (firstToken.lower !== "with") {
    return false;
  }

  const { ctes, mainQueryStartIndex } = parseCteDefinitions(tokens, startIndex, endIndex);
  for (const cte of ctes) {
    if (statementMutatesDataFromSegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex)) {
      return true;
    }
  }

  return statementMutatesDataFromSegment(tokens, mainQueryStartIndex, endIndex);
};

export const getAllowedRelationNames = (): ReadonlyArray<AllowedRelationName> => ALLOWED_RELATION_NAMES;

/**
 * Returns whether a SQL script mutates persisted data in any validated
 * statement. Multi-statement scripts are considered mutating when any one
 * statement is mutating.
 */
export const isExpenseSqlMutation = (sql: string): boolean =>
  validateExpenseSql(sql).statements.some((statement) => statement.isMutating);

const validateExpenseSqlStatement = (sql: string): ValidatedExpenseSqlStatement => {
  const firstKeyword = getFirstKeyword(sql);
  if (firstKeyword === undefined || !ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    fail("unsupported_statement", "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed");
  }

  if (containsSetConfig(sql)) {
    fail("set_config_not_allowed", "set_config() calls are not allowed");
  }

  assertSupportedSqlSyntax(sql);
  const sanitizedSql = stripSingleQuotedStrings(sql);
  if (containsOnConflict(sanitizedSql)) {
    fail("on_conflict_not_allowed", "ON CONFLICT is not supported in restricted SQL");
  }
  const tokens = tokenizeSql(sanitizedSql);
  assertOnlyAllowedFunctionCallsInSegment(tokens, 0, tokens.length);

  return {
    sql,
    isMutating: statementMutatesDataFromSegment(tokens, 0, tokens.length),
    referencedRelations: collectReferencedRelationsFromSegment(tokens, 0, tokens.length, new Set<string>()),
  };
};

export const validateExpenseSql = (sql: string): ValidatedExpenseSql => {
  const trimmedSql = sql.trim();
  const statements = splitSqlStatements(trimmedSql).map(validateExpenseSqlStatement);
  if (statements.length === 0) {
    fail("unsupported_statement", "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed");
  }

  return {
    sql: trimmedSql,
    statements,
  };
};

export const executeExpenseSql = async (
  sql: string,
  execute: (validatedSql: string) => Promise<RestrictedSqlQueryResult>,
): Promise<ExecutedExpenseSql> => {
  const validated = validateExpenseSql(sql);
  const statements: Array<ExecutedExpenseSqlStatement> = [];

  for (const statement of validated.statements) {
    const result = await execute(statement.sql);
    const rows = result.rows.slice(0, MAX_SQL_ROWS);
    const rowCount = rows.length > 0 ? rows.length : (result.rowCount ?? 0);
    const totalRowCount = result.rows.length > 0 ? result.rows.length : (result.rowCount ?? 0);
    statements.push({
      sql: statement.sql,
      command: result.command,
      isMutating: statement.isMutating,
      rows,
      rowCount,
      returnedRowCount: rows.length,
      totalRowCount,
      truncated: result.rows.length > rows.length,
      referencedRelations: statement.referencedRelations,
    });
  }

  return {
    sql: validated.sql,
    statements,
  };
};
