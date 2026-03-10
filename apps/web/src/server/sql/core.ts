/**
 * Shared SQL policy for machine-facing database access.
 *
 * The same validation rules and relation allowlist are reused by the API
 * Gateway SQL API and the app-side agent SQL transport.
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

/** Returns true if sql contains a semicolon outside of single-quoted strings. */
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

const parseCteNames = (tokens: ReadonlyArray<SqlToken>): ReadonlySet<string> => {
  const cteNames = new Set<string>();
  if (tokens.length === 0 || tokens[0]?.lower !== "with") {
    return cteNames;
  }

  let i = 1;
  if (tokens[i]?.lower === "recursive") {
    i++;
  }

  while (i < tokens.length) {
    const nameToken = tokens[i];
    if (nameToken === undefined || nameToken.kind !== "word") {
      break;
    }
    cteNames.add(nameToken.lower);
    i++;

    if (tokens[i]?.value === "(") {
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        if (tokens[i]?.value === "(") {
          depth++;
        }
        if (tokens[i]?.value === ")") {
          depth--;
        }
        i++;
      }
    }

    if (tokens[i]?.lower !== "as" || tokens[i + 1]?.value !== "(") {
      break;
    }

    i += 2;
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      if (tokens[i]?.value === "(") {
        depth++;
      }
      if (tokens[i]?.value === ")") {
        depth--;
      }
      i++;
    }

    if (tokens[i]?.value !== ",") {
      break;
    }
    i++;
  }

  return cteNames;
};

const parseRelationName = (
  tokens: ReadonlyArray<SqlToken>,
  startIndex: number,
): Readonly<{ relationName: string; nextIndex: number }> => {
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
    };
  }

  return {
    relationName: first.lower,
    nextIndex: startIndex + 1,
  };
};

const asAllowedRelationName = (value: string): AllowedRelationName => value as AllowedRelationName;

const collectReferencedRelations = (sql: string): ReadonlyArray<AllowedRelationName> => {
  assertSupportedSqlSyntax(sql);
  const sanitizedSql = stripSingleQuotedStrings(sql);
  const tokens = tokenizeSql(sanitizedSql);
  const cteNames = parseCteNames(tokens);
  const relations = new Set<AllowedRelationName>();

  let inSourceClause = false;
  let sourceDepth = 0;
  let expectRelation = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }

    if (token.kind === "punct") {
      if (inSourceClause && sourceDepth === 0 && token.value === ",") {
        expectRelation = true;
        continue;
      }

      if (token.value === "(") {
        if (inSourceClause && expectRelation && sourceDepth === 0) {
          expectRelation = false;
        }
        sourceDepth++;
        continue;
      }

      if (token.value === ")" && sourceDepth > 0) {
        sourceDepth--;
      }
      continue;
    }

    if (token.lower === "update" || token.lower === "into") {
      const { relationName } = parseRelationName(tokens, i + 1);
      if (!ALLOWED_RELATIONS.has(relationName)) {
        fail("relation_not_allowed", `Relation ${relationName} is not allowed`);
      }
      relations.add(asAllowedRelationName(relationName));
      continue;
    }

    if (token.lower === "delete" && tokens[i + 1]?.lower === "from") {
      const { relationName } = parseRelationName(tokens, i + 2);
      if (!ALLOWED_RELATIONS.has(relationName)) {
        fail("relation_not_allowed", `Relation ${relationName} is not allowed`);
      }
      relations.add(asAllowedRelationName(relationName));
      continue;
    }

    if (token.lower === "from") {
      inSourceClause = true;
      sourceDepth = 0;
      expectRelation = true;
      continue;
    }

    if (inSourceClause && sourceDepth === 0 && SOURCE_CLAUSE_END.has(token.lower)) {
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

    const { relationName, nextIndex } = parseRelationName(tokens, i);
    if (!cteNames.has(relationName) && !ALLOWED_RELATIONS.has(relationName)) {
      fail("relation_not_allowed", `Relation ${relationName} is not allowed`);
    }
    if (ALLOWED_RELATIONS.has(relationName)) {
      relations.add(asAllowedRelationName(relationName));
    }
    expectRelation = false;
    i = nextIndex - 1;
  }

  return Array.from(relations);
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
