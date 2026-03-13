/**
 * Shared SQL policy for machine-facing database access.
 */
export const MAX_SQL_ROWS = 100;
export const SQL_STATEMENT_TIMEOUT_MS = 30_000;

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
  "exchange_rates",
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
  | "multiple_statements_not_allowed"
  | "set_config_not_allowed"
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
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

export type RestrictedSqlResultRow = Readonly<Record<string, unknown>>;

export type RestrictedSqlQueryResult = Readonly<{
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number | null;
}>;

export type ExecutedExpenseSql = Readonly<{
  rows: ReadonlyArray<RestrictedSqlResultRow>;
  rowCount: number;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

const fail = (code: SqlPolicyErrorCode, message: string): never => {
  throw new SqlPolicyError(code, message);
};

const getFirstKeyword = (sql: string): string | undefined =>
  sql.trimStart().split(/\s/u)[0]?.toUpperCase();

const hasMultipleStatements = (sql: string): boolean => {
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inString) {
      inString = true;
    } else if (ch === "'" && inString) {
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        i++;
      } else {
        inString = false;
      }
    } else if (ch === ";" && !inString) {
      return true;
    }
  }
  return false;
};

const containsSetConfig = (sql: string): boolean => /\bset_config\b/iu.test(sql);

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
  const tokens = tokenizeSql(sanitizedSql);
  return collectReferencedRelationsFromSegment(tokens, 0, tokens.length, new Set<string>());
};

export const getAllowedRelationNames = (): ReadonlyArray<AllowedRelationName> => ALLOWED_RELATION_NAMES;

export const validateExpenseSql = (sql: string): ValidatedExpenseSql => {
  const trimmedSql = sql.trim();
  const firstKeyword = getFirstKeyword(trimmedSql);
  if (firstKeyword === undefined || !ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    fail("unsupported_statement", "Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed");
  }

  if (hasMultipleStatements(trimmedSql)) {
    fail("multiple_statements_not_allowed", "Multiple statements are not allowed");
  }

  if (containsSetConfig(trimmedSql)) {
    fail("set_config_not_allowed", "set_config() calls are not allowed");
  }

  return {
    sql: trimmedSql,
    referencedRelations: collectReferencedRelations(trimmedSql),
  };
};

export const executeExpenseSql = async (
  sql: string,
  execute: (validatedSql: string) => Promise<RestrictedSqlQueryResult>,
): Promise<ExecutedExpenseSql> => {
  const validated = validateExpenseSql(sql);
  const result = await execute(validated.sql);
  const rows = result.rows.slice(0, MAX_SQL_ROWS);
  const rowCount = rows.length > 0 ? rows.length : (result.rowCount ?? 0);

  return {
    rows,
    rowCount,
    referencedRelations: validated.referencedRelations,
  };
};
