/**
 * Shared SQL policy for machine-facing database access.
 */
export const MAX_SQL_ROWS = 100;
export const MAX_SQL_RETURNED_ROWS = 100;
export const MAX_SQL_MUTATION_ROWS = 100;
export const MAX_SQL_SCRIPT_LENGTH = 100_000;
export const MAX_SQL_STATEMENTS = 100;
export const SQL_STATEMENT_TIMEOUT_MS = 25_000;
export const MCP_SQL_STATEMENT_TIMEOUT_MS = 20_000;

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

const ALLOWED_EFFECTIVE_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  "select", "insert", "update", "delete",
]);

const ALLOWED_CTE_BODY_KEYWORDS: ReadonlySet<string> = new Set([
  "select", "values",
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

const SQL_GRAMMAR_PAREN_KEYWORDS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "where",
  "in",
  "exists",
  "values",
]);

const SQL_DERIVED_QUERY_PAREN_KEYWORDS: ReadonlySet<string> = new Set([
  "from",
  "join",
]);

const DERIVED_QUERY_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "with",
  "values",
]);

const ALLOWED_RELATION_NAMES = [
  "ledger_entries",
  "accounts",
  "budget_lines",
  "workspace_settings",
  "account_metadata",
  "fx_rates_raw",
  "fx_rates_daily",
] as const;

export type AllowedRelationName = typeof ALLOWED_RELATION_NAMES[number];

const ALLOWED_RELATIONS: ReadonlySet<string> = new Set(ALLOWED_RELATION_NAMES);

const READ_ONLY_RELATION_NAMES: ReadonlyArray<AllowedRelationName> = [
  "accounts",
  "fx_rates_raw",
  "fx_rates_daily",
] as const;

const READ_ONLY_RELATIONS: ReadonlySet<AllowedRelationName> = new Set<AllowedRelationName>(
  READ_ONLY_RELATION_NAMES,
);

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

type MutationOperation = "INSERT" | "UPDATE" | "DELETE";

type SqlGrammarContext = "statement" | "delete_using" | "delete_using_source";

type MutationTarget = Readonly<{
  operation: MutationOperation;
  relationName: AllowedRelationName;
}>;

type SqlPolicyErrorCode =
  | "unsupported_statement"
  | "single_statement_required"
  | "sql_script_too_long"
  | "too_many_sql_statements"
  | "mutation_statement_row_limit_exceeded"
  | "mutation_request_row_limit_exceeded"
  | "read_only_sql_required"
  | "mutation_sql_required"
  | "on_conflict_not_allowed"
  | "set_config_not_allowed"
  | "function_calls_not_allowed"
  | "sql_comments_not_allowed"
  | "quoted_identifiers_not_allowed"
  | "dollar_quoted_strings_not_allowed"
  | "escape_string_literals_not_allowed"
  | "unterminated_string_literal"
  | "invalid_relation_reference"
  | "relation_not_allowed"
  | "recursive_cte_search_cycle_not_allowed"
  | "read_only_relation_mutation_not_allowed";

export class SqlPolicyError extends Error {
  readonly code: SqlPolicyErrorCode;

  constructor(code: SqlPolicyErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class SqlExecutionDeadlineError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`SQL execution exceeded its ${String(timeoutMs)} ms total deadline before the next database command could start`);
    this.timeoutMs = timeoutMs;
  }
}

export type ValidatedExpenseSql = Readonly<{
  sql: string;
  statements: ReadonlyArray<ValidatedExpenseSqlStatement>;
}>;

export type ValidatedReadOnlyExpenseSql = ValidatedExpenseSql & Readonly<{
  isReadOnly: true;
}>;

export type ValidatedMutationExpenseSql = ValidatedExpenseSql & Readonly<{
  isMutation: true;
}>;

export type RestrictedSqlResultRow = Readonly<Record<string, unknown>>;

export type RestrictedSqlQueryResult = Readonly<{
  command: string;
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number | null;
}>;

export type RestrictedSqlExecutionRequest = Readonly<{
  sql: string;
  params: ReadonlyArray<unknown>;
}>;

export type SqlExecutionDeadline = Readonly<{
  timeoutMs: number;
  expiresAtMs: number;
  now: () => number;
}>;

export type DeadlineRestrictedSqlExecutor = (
  request: RestrictedSqlExecutionRequest,
  statementTimeoutMs: number,
) => Promise<RestrictedSqlQueryResult>;

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

export const createSqlExecutionDeadline = (
  timeoutMs: number,
  now: () => number,
): SqlExecutionDeadline => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("SQL execution timeout must be a positive safe integer number of milliseconds");
  }
  const startedAtMs = now();
  if (!Number.isSafeInteger(startedAtMs)) {
    throw new TypeError("SQL execution clock must return a safe integer number of milliseconds");
  }

  return {
    timeoutMs,
    expiresAtMs: startedAtMs + timeoutMs,
    now,
  };
};

export const getRemainingSqlExecutionMs = (
  deadline: SqlExecutionDeadline,
): number => {
  const currentTimeMs = deadline.now();
  if (!Number.isSafeInteger(currentTimeMs)) {
    throw new TypeError("SQL execution clock must return a safe integer number of milliseconds");
  }
  const remainingMs = Math.min(
    deadline.timeoutMs,
    deadline.expiresAtMs - currentTimeMs,
  );
  if (remainingMs <= 0) {
    throw new SqlExecutionDeadlineError(deadline.timeoutMs);
  }
  return remainingMs;
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

const sanitizeSqlForTokenization = (sql: string): string => {
  let result = "";
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!inString) {
      const previousCh = sql[i - 1];
      if (
        (ch === "E" || ch === "e")
        && sql[i + 1] === "'"
        && (previousCh === undefined || !isWordPart(previousCh))
      ) {
        fail(
          "escape_string_literals_not_allowed",
          "PostgreSQL escape string literals are not allowed",
        );
      }
      if (ch === "'") {
        inString = true;
        result += " ";
        continue;
      }
      if ((ch === "-" && sql[i + 1] === "-") || (ch === "/" && sql[i + 1] === "*")) {
        fail("sql_comments_not_allowed", "SQL comments are not allowed");
      }
      if (ch === "\"") {
        fail("quoted_identifiers_not_allowed", "Quoted identifiers are not allowed");
      }
      if (ch === "$") {
        fail(
          "dollar_quoted_strings_not_allowed",
          "Dollar signs outside regular string literals are not allowed",
        );
      }
      result += ch;
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

const isSourceClauseBoundary = (
  tokens: ReadonlyArray<SqlToken>,
  index: number,
): boolean => {
  const token = tokens[index];
  if (token === undefined || !SOURCE_CLAUSE_END.has(token.lower)) {
    return false;
  }

  const previousIndex = findPreviousSignificantIndex(tokens, index - 1);
  return previousIndex === null || tokens[previousIndex]?.value !== ".";
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

const startsWithDerivedQuery = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): boolean => {
  const normalized = unwrapParenthesizedSegment(tokens, startIndex, endIndex);
  const firstToken = tokens[normalized.startIndex];
  return firstToken !== undefined && DERIVED_QUERY_FIRST_KEYWORDS.has(firstToken.lower);
};

const findDeleteUsingClauseIndex = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): number | null => {
  if (
    tokens[startIndex]?.lower !== "delete"
    || tokens[startIndex + 1]?.lower !== "from"
  ) {
    return null;
  }

  const targetStartIndex = tokens[startIndex + 2]?.lower === "only"
    ? startIndex + 3
    : startIndex + 2;
  const target = parseRelationName(tokens, targetStartIndex);
  let index = target.nextIndex;

  if (tokens[index]?.value === "*") {
    index += 1;
  }

  if (tokens[index]?.lower === "as") {
    if (tokens[index + 1]?.kind !== "word") {
      return null;
    }
    index += 2;
  } else if (
    tokens[index]?.kind === "word"
    && tokens[index]?.lower !== "using"
    && !isSourceClauseBoundary(tokens, index)
  ) {
    index += 1;
  }

  return index < endIndex && tokens[index]?.lower === "using" ? index : null;
};

const collectReferencedRelationsFromSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
  visibleCteNames: ReadonlySet<string>,
  grammarContext: SqlGrammarContext,
): ReadonlyArray<AllowedRelationName> => {
  if (startIndex >= endIndex) {
    return [];
  }

  if (tokens[startIndex]?.lower === "with") {
    return collectReferencedRelationsFromWithClause(
      tokens,
      startIndex,
      endIndex,
      visibleCteNames,
      grammarContext,
    );
  }

  const relations = new Set<AllowedRelationName>();
  const deleteUsingClauseIndex = findDeleteUsingClauseIndex(tokens, startIndex, endIndex);
  let understandsDeleteUsingGrammar = grammarContext !== "statement";
  let inSourceClause = grammarContext === "delete_using_source";
  let inDeleteUsingSource = grammarContext === "delete_using_source";
  let expectRelation = grammarContext === "delete_using_source";
  let joinExpectsCondition = false;

  for (let i = startIndex; i < endIndex; i++) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }

    if (token.kind === "punct") {
      if (token.value === "(") {
        const closeIndex = findMatchingParen(tokens, i, endIndex);
        const startsNestedDeleteUsingSource = inDeleteUsingSource
          && expectRelation
          && !startsWithDerivedQuery(tokens, i + 1, closeIndex);
        if (inSourceClause && expectRelation) {
          expectRelation = false;
        }
        const nestedGrammarContext: SqlGrammarContext = understandsDeleteUsingGrammar
          ? startsNestedDeleteUsingSource
            ? "delete_using_source"
            : "delete_using"
          : "statement";
        mergeRelations(
          relations,
          collectReferencedRelationsFromSegment(
            tokens,
            i + 1,
            closeIndex,
            visibleCteNames,
            nestedGrammarContext,
          ),
        );
        i = closeIndex;
        continue;
      }

      if (inSourceClause && token.value === ",") {
        expectRelation = true;
        joinExpectsCondition = false;
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

    if (i === deleteUsingClauseIndex) {
      understandsDeleteUsingGrammar = true;
      inSourceClause = true;
      inDeleteUsingSource = true;
      expectRelation = true;
      joinExpectsCondition = false;
      continue;
    }

    if (
      inSourceClause
      && joinExpectsCondition
      && token.lower === "using"
      && tokens[i + 1]?.value === "("
    ) {
      i = findMatchingParen(tokens, i + 1, endIndex);
      joinExpectsCondition = false;
      continue;
    }

    if (token.lower === "from") {
      inSourceClause = true;
      inDeleteUsingSource = understandsDeleteUsingGrammar;
      expectRelation = true;
      joinExpectsCondition = false;
      continue;
    }

    if (inSourceClause && isSourceClauseBoundary(tokens, i)) {
      inSourceClause = false;
      inDeleteUsingSource = false;
      expectRelation = false;
      joinExpectsCondition = false;
      continue;
    }

    if (inSourceClause && token.lower === "join") {
      expectRelation = true;
      joinExpectsCondition = true;
      continue;
    }

    if (inSourceClause && token.lower === "on") {
      joinExpectsCondition = false;
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
    if (
      isRecursive
      && (tokens[index]?.lower === "search" || tokens[index]?.lower === "cycle")
    ) {
      fail(
        "recursive_cte_search_cycle_not_allowed",
        "Recursive CTE SEARCH and CYCLE clauses are not supported in restricted SQL",
      );
    }
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

const unwrapParenthesizedSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): Readonly<{ startIndex: number; endIndex: number }> => {
  let normalizedStartIndex = startIndex;
  let normalizedEndIndex = endIndex;

  while (
    tokens[normalizedStartIndex]?.value === "("
    && findMatchingParen(tokens, normalizedStartIndex, normalizedEndIndex) === normalizedEndIndex - 1
  ) {
    normalizedStartIndex += 1;
    normalizedEndIndex -= 1;
  }

  return { startIndex: normalizedStartIndex, endIndex: normalizedEndIndex };
};

const assertSupportedNestedWithClauses = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): void => {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index]?.value !== "(") {
      continue;
    }

    const closeIndex = findMatchingParen(tokens, index, endIndex);
    const nested = unwrapParenthesizedSegment(tokens, index + 1, closeIndex);
    if (tokens[nested.startIndex]?.lower === "with") {
      assertSupportedCteBodySegment(tokens, nested.startIndex, nested.endIndex);
    } else {
      assertSupportedNestedWithClauses(tokens, nested.startIndex, nested.endIndex);
    }
    index = closeIndex;
  }
};

const assertSupportedCteBodySegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): void => {
  const normalized = unwrapParenthesizedSegment(tokens, startIndex, endIndex);
  const effectiveStatement = tokens[normalized.startIndex];
  if (effectiveStatement?.lower === "with") {
    const { ctes, mainQueryStartIndex } = parseCteDefinitions(
      tokens,
      normalized.startIndex,
      normalized.endIndex,
    );
    for (const cte of ctes) {
      assertSupportedCteBodySegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex);
    }
    assertSupportedCteBodySegment(tokens, mainQueryStartIndex, normalized.endIndex);
    return;
  }

  if (
    effectiveStatement === undefined
    || effectiveStatement.kind !== "word"
    || !ALLOWED_CTE_BODY_KEYWORDS.has(effectiveStatement.lower)
  ) {
    fail(
      "unsupported_statement",
      "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
    );
  }

  assertSupportedNestedWithClauses(tokens, normalized.startIndex, normalized.endIndex);
};

const assertSupportedEffectiveStatementsInSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): void => {
  const normalized = unwrapParenthesizedSegment(tokens, startIndex, endIndex);
  const effectiveStatement = tokens[normalized.startIndex];
  if (effectiveStatement?.lower === "with") {
    const { ctes, mainQueryStartIndex } = parseCteDefinitions(
      tokens,
      normalized.startIndex,
      normalized.endIndex,
    );
    for (const cte of ctes) {
      assertSupportedCteBodySegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex);
    }
    assertSupportedEffectiveStatementsInSegment(
      tokens,
      mainQueryStartIndex,
      normalized.endIndex,
    );
    return;
  }

  if (
    effectiveStatement === undefined
    || effectiveStatement.kind !== "word"
    || !ALLOWED_EFFECTIVE_STATEMENT_KEYWORDS.has(effectiveStatement.lower)
  ) {
    fail(
      "unsupported_statement",
      "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed",
    );
  }

  assertSupportedNestedWithClauses(tokens, normalized.startIndex, normalized.endIndex);
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
  grammarContext: SqlGrammarContext,
): void => {
  if (startIndex >= endIndex) {
    return;
  }

  if (tokens[startIndex]?.lower === "with") {
    const { ctes, mainQueryStartIndex } = parseCteDefinitions(tokens, startIndex, endIndex);
    for (const cte of ctes) {
      assertOnlyAllowedFunctionCallsInSegment(
        tokens,
        cte.bodyStartIndex,
        cte.bodyEndIndex,
        grammarContext,
      );
    }
    assertOnlyAllowedFunctionCallsInSegment(
      tokens,
      mainQueryStartIndex,
      endIndex,
      grammarContext,
    );
    return;
  }

  const deleteUsingClauseIndex = findDeleteUsingClauseIndex(tokens, startIndex, endIndex);
  let understandsDeleteUsingGrammar = grammarContext !== "statement";
  let inDeleteUsingSource = grammarContext === "delete_using_source";
  let expectDeleteUsingRelation = inDeleteUsingSource;
  let joinExpectsCondition = false;

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
      if (inDeleteUsingSource && token.value === ",") {
        expectDeleteUsingRelation = true;
        joinExpectsCondition = false;
      }
      if (token.value === "(") {
        const closeIndex = findMatchingParen(tokens, index, endIndex);
        const startsNestedDeleteUsingSource = inDeleteUsingSource
          && expectDeleteUsingRelation
          && !startsWithDerivedQuery(tokens, index + 1, closeIndex);
        const nestedGrammarContext: SqlGrammarContext = understandsDeleteUsingGrammar
          ? startsNestedDeleteUsingSource
            ? "delete_using_source"
            : "delete_using"
          : "statement";
        assertOnlyAllowedFunctionCallsInSegment(
          tokens,
          index + 1,
          closeIndex,
          nestedGrammarContext,
        );
        expectDeleteUsingRelation = false;
        index = closeIndex;
      }
      continue;
    }

    const previousIndex = findPreviousSignificantIndex(tokens, index - 1);
    const previousToken = previousIndex === null ? undefined : tokens[previousIndex];
    if (tokens[index + 1]?.value === "(" && previousToken?.value === ".") {
      if (
        previousIndex !== null
        && previousIndex >= 2
        && tokens[previousIndex - 1]?.lower === "public"
        && tokens[previousIndex - 2]?.lower === "into"
      ) {
        continue;
      }
      failFunctionCallNotAllowed(token.value);
    }

    if (index === deleteUsingClauseIndex) {
      understandsDeleteUsingGrammar = true;
      inDeleteUsingSource = true;
      expectDeleteUsingRelation = true;
      joinExpectsCondition = false;
      continue;
    }

    if (
      inDeleteUsingSource
      && joinExpectsCondition
      && token.lower === "using"
      && tokens[index + 1]?.value === "("
    ) {
      index = findMatchingParen(tokens, index + 1, endIndex);
      joinExpectsCondition = false;
      continue;
    }

    if (inDeleteUsingSource && isSourceClauseBoundary(tokens, index)) {
      inDeleteUsingSource = false;
      expectDeleteUsingRelation = false;
      joinExpectsCondition = false;
    }

    if (inDeleteUsingSource && token.lower === "join") {
      expectDeleteUsingRelation = true;
      joinExpectsCondition = true;
      continue;
    }

    if (inDeleteUsingSource && token.lower === "on") {
      joinExpectsCondition = false;
      continue;
    }

    if (understandsDeleteUsingGrammar && token.lower === "from") {
      inDeleteUsingSource = true;
      expectDeleteUsingRelation = true;
      joinExpectsCondition = false;
      continue;
    }

    if (inDeleteUsingSource && expectDeleteUsingRelation) {
      expectDeleteUsingRelation = false;
    }

    if (tokens[index + 1]?.value !== "(") {
      continue;
    }

    const derivedQueryFirstToken = tokens[index + 2];
    const startsDerivedQuery = derivedQueryFirstToken !== undefined
      && DERIVED_QUERY_FIRST_KEYWORDS.has(derivedQueryFirstToken.lower);
    if (
      SQL_GRAMMAR_PAREN_KEYWORDS.has(token.lower)
      || (SQL_DERIVED_QUERY_PAREN_KEYWORDS.has(token.lower) && startsDerivedQuery)
    ) {
      const closeIndex = findMatchingParen(tokens, index + 1, endIndex);
      const nestedGrammarContext = understandsDeleteUsingGrammar
        ? "delete_using"
        : "statement";
      assertOnlyAllowedFunctionCallsInSegment(
        tokens,
        index + 2,
        closeIndex,
        nestedGrammarContext,
      );
      index = closeIndex;
      continue;
    }

    if (!ALLOWED_SQL_FUNCTIONS.has(token.lower)) {
      failFunctionCallNotAllowed(token.value);
    }

    const closeIndex = findMatchingParen(tokens, index + 1, endIndex);
    assertOnlyAllowedFunctionCallsInSegment(
      tokens,
      index + 2,
      closeIndex,
      understandsDeleteUsingGrammar ? "delete_using" : "statement",
    );
    index = closeIndex;
  }
};

const collectReferencedRelationsFromWithClause = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
  outerVisibleCteNames: ReadonlySet<string>,
  grammarContext: SqlGrammarContext,
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
        grammarContext,
      ),
    );

    visibleCteNames.add(cte.name);
  }

  mergeRelations(
    relations,
    collectReferencedRelationsFromSegment(
      tokens,
      mainQueryStartIndex,
      endIndex,
      visibleCteNames,
      grammarContext,
    ),
  );

  return Array.from(relations);
};

const collectMutationTarget = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  operation: MutationOperation,
): MutationTarget => {
  const targetStartIndex = tokens[startIndex]?.lower === "only" ? startIndex + 1 : startIndex;
  const reference = parseRelationName(tokens, targetStartIndex);
  if (!ALLOWED_RELATIONS.has(reference.relationName)) {
    fail("relation_not_allowed", `Relation ${reference.relationName} is not allowed`);
  }

  return {
    operation,
    relationName: asAllowedRelationName(reference.relationName),
  };
};

const collectMutationTargetsFromSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): ReadonlyArray<MutationTarget> => {
  const normalized = unwrapParenthesizedSegment(tokens, startIndex, endIndex);
  if (normalized.startIndex >= normalized.endIndex) {
    return [];
  }

  const firstToken = tokens[normalized.startIndex];
  if (firstToken === undefined || firstToken.kind !== "word") {
    return [];
  }

  if (firstToken.lower === "insert" && tokens[normalized.startIndex + 1]?.lower === "into") {
    return [collectMutationTarget(tokens, normalized.startIndex + 2, "INSERT")];
  }

  if (firstToken.lower === "update") {
    return [collectMutationTarget(tokens, normalized.startIndex + 1, "UPDATE")];
  }

  if (firstToken.lower === "delete" && tokens[normalized.startIndex + 1]?.lower === "from") {
    return [collectMutationTarget(tokens, normalized.startIndex + 2, "DELETE")];
  }

  if (firstToken.lower !== "with") {
    return [];
  }

  const { ctes, mainQueryStartIndex } = parseCteDefinitions(
    tokens,
    normalized.startIndex,
    normalized.endIndex,
  );
  const targets: Array<MutationTarget> = [];
  for (const cte of ctes) {
    targets.push(...collectMutationTargetsFromSegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex));
  }
  targets.push(...collectMutationTargetsFromSegment(tokens, mainQueryStartIndex, normalized.endIndex));
  return targets;
};

const assertMutationTargetsAreWritable = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): void => {
  for (const target of collectMutationTargetsFromSegment(tokens, startIndex, endIndex)) {
    if (READ_ONLY_RELATIONS.has(target.relationName)) {
      fail(
        "read_only_relation_mutation_not_allowed",
        `Relation ${target.relationName} is SELECT-only and cannot be targeted by ${target.operation} in restricted SQL`,
      );
    }
  }
};

const collectReferencedRelations = (sql: string): ReadonlyArray<AllowedRelationName> => {
  const sanitizedSql = sanitizeSqlForTokenization(sql);
  if (containsOnConflict(sanitizedSql)) {
    fail("on_conflict_not_allowed", "ON CONFLICT is not supported in restricted SQL");
  }
  const tokens = tokenizeSql(sanitizedSql);
  return collectReferencedRelationsFromSegment(
    tokens,
    0,
    tokens.length,
    new Set<string>(),
    "statement",
  );
};

/**
 * Classifies whether a validated SQL statement mutates persisted data.
 *
 * Write classification comes from the validated SQL structure rather than the
 * eventual PostgreSQL command tag. Read-only CTE bodies may feed a top-level
 * INSERT, UPDATE, or DELETE, so downstream code carries this explicit flag.
 */
const statementMutatesDataFromSegment = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
  endIndex: number,
): boolean => {
  const normalized = unwrapParenthesizedSegment(tokens, startIndex, endIndex);
  if (normalized.startIndex >= normalized.endIndex) {
    return false;
  }

  const firstToken = tokens[normalized.startIndex];
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

  const { ctes, mainQueryStartIndex } = parseCteDefinitions(
    tokens,
    normalized.startIndex,
    normalized.endIndex,
  );
  for (const cte of ctes) {
    if (statementMutatesDataFromSegment(tokens, cte.bodyStartIndex, cte.bodyEndIndex)) {
      return true;
    }
  }

  return statementMutatesDataFromSegment(tokens, mainQueryStartIndex, normalized.endIndex);
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

  const sanitizedSql = sanitizeSqlForTokenization(sql);
  if (containsOnConflict(sanitizedSql)) {
    fail("on_conflict_not_allowed", "ON CONFLICT is not supported in restricted SQL");
  }
  const tokens = tokenizeSql(sanitizedSql);
  assertSupportedEffectiveStatementsInSegment(tokens, 0, tokens.length);
  assertMutationTargetsAreWritable(tokens, 0, tokens.length);
  assertOnlyAllowedFunctionCallsInSegment(tokens, 0, tokens.length, "statement");

  return {
    sql,
    isMutating: statementMutatesDataFromSegment(tokens, 0, tokens.length),
    referencedRelations: collectReferencedRelationsFromSegment(
      tokens,
      0,
      tokens.length,
      new Set<string>(),
      "statement",
    ),
  };
};

const assertSqlScriptLength = (sql: string): void => {
  if (sql.length > MAX_SQL_SCRIPT_LENGTH) {
    fail(
      "sql_script_too_long",
      `SQL scripts must be ${MAX_SQL_SCRIPT_LENGTH} characters or fewer`,
    );
  }
};

export const validateExpenseSql = (sql: string): ValidatedExpenseSql => {
  assertSqlScriptLength(sql);

  const trimmedSql = sql.trim();
  const rawStatements = splitSqlStatements(trimmedSql);
  if (rawStatements.length > MAX_SQL_STATEMENTS) {
    fail(
      "too_many_sql_statements",
      `SQL scripts must contain ${MAX_SQL_STATEMENTS} statements or fewer`,
    );
  }

  const statements = rawStatements.map(validateExpenseSqlStatement);
  if (statements.length === 0) {
    fail("unsupported_statement", "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed");
  }

  return {
    sql: trimmedSql,
    statements,
  };
};

export const validateReadOnlyExpenseSql = (sql: string): ValidatedReadOnlyExpenseSql => {
  const validated = validateExpenseSql(sql);
  if (validated.statements.some((statement) => statement.isMutating)) {
    fail(
      "read_only_sql_required",
      "Read-only SQL cannot contain INSERT, UPDATE, DELETE, or data-modifying CTEs",
    );
  }

  return {
    ...validated,
    isReadOnly: true,
  };
};

const assertSingleStatement = (validated: ValidatedExpenseSql): void => {
  if (validated.statements.length !== 1) {
    fail("single_statement_required", "This SQL endpoint accepts exactly one statement");
  }
};

export const validateSingleExpenseSql = (sql: string): ValidatedExpenseSql => {
  assertSqlScriptLength(sql);
  if (splitSqlStatements(sql.trim()).length > 1) {
    fail("single_statement_required", "This SQL endpoint accepts exactly one statement");
  }
  const validated = validateExpenseSql(sql);
  assertSingleStatement(validated);
  return validated;
};

export const validateSingleReadOnlyExpenseSql = (sql: string): ValidatedReadOnlyExpenseSql => {
  const validated = validateSingleExpenseSql(sql);
  if (validated.statements.some((statement) => statement.isMutating)) {
    fail(
      "read_only_sql_required",
      "Read-only SQL cannot contain INSERT, UPDATE, DELETE, or data-modifying CTEs",
    );
  }

  return {
    ...validated,
    isReadOnly: true,
  };
};

export const validateSingleMutationExpenseSql = (sql: string): ValidatedMutationExpenseSql => {
  const validated = validateSingleExpenseSql(sql);
  if (validated.statements.every((statement) => !statement.isMutating)) {
    fail(
      "mutation_sql_required",
      "Exactly one INSERT, UPDATE, or DELETE mutation is required; send SELECT and WITH...SELECT to the query endpoint",
    );
  }

  return {
    ...validated,
    isMutation: true,
  };
};

const getAffectedRowCount = (result: RestrictedSqlQueryResult): number => {
  const rowCount = result.rowCount;
  if (rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new TypeError("Restricted SQL execution returned an invalid affected row count");
  }
  return rowCount;
};

const executeBoundedRead = async (
  statement: ValidatedExpenseSqlStatement,
  statementIndex: number,
  maxRows: number,
  execute: (request: RestrictedSqlExecutionRequest) => Promise<RestrictedSqlQueryResult>,
): Promise<Readonly<{
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  totalRowCount: number;
}>> => {
  const cursorName = `api_sql_read_cursor_${String(statementIndex + 1)}`;
  await execute({
    sql: `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${statement.sql}`,
    params: [],
  });
  const fetched = await execute({
    sql: `FETCH FORWARD ${String(maxRows + 1)} FROM ${cursorName}`,
    params: [],
  });
  if (fetched.rowCount !== null && fetched.rowCount !== fetched.rows.length) {
    throw new TypeError("Restricted SQL cursor FETCH returned inconsistent row metadata");
  }

  const moved = await execute({
    sql: `MOVE FORWARD ALL FROM ${cursorName}`,
    params: [],
  });
  const remainingRowCount = getAffectedRowCount(moved);
  await execute({ sql: `CLOSE ${cursorName}`, params: [] });

  return {
    rows: fetched.rows.slice(0, maxRows),
    totalRowCount: fetched.rows.length + remainingRowCount,
  };
};

export const executeValidatedExpenseSql = async (
  validated: ValidatedExpenseSql,
  execute: (request: RestrictedSqlExecutionRequest) => Promise<RestrictedSqlQueryResult>,
): Promise<ExecutedExpenseSql> => {
  const statements: Array<ExecutedExpenseSqlStatement> = [];
  let returnedRowCount = 0;
  let mutationRowCount = 0;

  for (let statementIndex = 0; statementIndex < validated.statements.length; statementIndex += 1) {
    const statement = validated.statements[statementIndex];
    if (statement === undefined) {
      throw new TypeError(`Validated SQL statement ${String(statementIndex + 1)} is missing`);
    }
    const statementRowLimit = Math.min(
      MAX_SQL_ROWS,
      Math.max(MAX_SQL_RETURNED_ROWS - returnedRowCount, 0),
    );

    if (!statement.isMutating) {
      const boundedRead = await executeBoundedRead(
        statement,
        statementIndex,
        statementRowLimit,
        execute,
      );
      returnedRowCount += boundedRead.rows.length;
      statements.push({
        sql: statement.sql,
        command: "SELECT",
        isMutating: false,
        rows: boundedRead.rows,
        rowCount: boundedRead.rows.length,
        returnedRowCount: boundedRead.rows.length,
        totalRowCount: boundedRead.totalRowCount,
        truncated: boundedRead.totalRowCount > boundedRead.rows.length,
        referencedRelations: statement.referencedRelations,
      });
      continue;
    }

    const result = await execute({ sql: statement.sql, params: [] });
    const affectedRowCount = getAffectedRowCount(result);

    if (affectedRowCount > MAX_SQL_MUTATION_ROWS) {
      fail(
        "mutation_statement_row_limit_exceeded",
        `A SQL mutation may affect at most ${MAX_SQL_MUTATION_ROWS} rows per statement; this statement affected ${affectedRowCount}`,
      );
    }
    mutationRowCount += affectedRowCount;
    if (mutationRowCount > MAX_SQL_MUTATION_ROWS) {
      fail(
        "mutation_request_row_limit_exceeded",
        `A SQL request may affect at most ${MAX_SQL_MUTATION_ROWS} rows; this request affected ${mutationRowCount}`,
      );
    }

    const totalRowCount = result.rows.length > 0 ? result.rows.length : affectedRowCount;
    const rows = result.rows.slice(0, statementRowLimit);
    returnedRowCount += rows.length;
    statements.push({
      sql: statement.sql,
      command: result.command,
      isMutating: statement.isMutating,
      rows,
      rowCount: rows.length === 0 ? affectedRowCount : rows.length,
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

export const executeValidatedExpenseSqlWithinDeadline = async (
  validated: ValidatedExpenseSql,
  deadline: SqlExecutionDeadline,
  execute: DeadlineRestrictedSqlExecutor,
): Promise<ExecutedExpenseSql> => executeValidatedExpenseSql(
  validated,
  (request) => execute(request, getRemainingSqlExecutionMs(deadline)),
);

export const executeExpenseSql = async (
  sql: string,
  execute: (request: RestrictedSqlExecutionRequest) => Promise<RestrictedSqlQueryResult>,
): Promise<ExecutedExpenseSql> => executeValidatedExpenseSql(validateExpenseSql(sql), execute);
