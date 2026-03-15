import {
  executeExpenseSql,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlPolicyError,
  type AllowedRelationName,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AuthenticatedContext, EntityHints, MachineApiDependencies, PgError } from "./types.js";
import { getWorkspace } from "./workspaceService.js";

const ENTITY_METADATA: Readonly<Record<AllowedRelationName, Readonly<{
  summary: string;
  related: ReadonlyArray<AllowedRelationName>;
}>>> = {
  ledger_entries: {
    summary: "One row per account movement, including income, spending, and transfers.",
    related: ["accounts", "workspace_settings", "account_metadata"],
  },
  accounts: {
    summary: "Derived account list built from ledger entries.",
    related: ["ledger_entries", "account_metadata", "workspace_settings"],
  },
  budget_lines: {
    summary: "Append-only monthly budget plan rows with last-write-wins semantics.",
    related: ["budget_comments", "workspace_settings"],
  },
  budget_comments: {
    summary: "Append-only comments attached to monthly budget categories.",
    related: ["budget_lines", "workspace_settings"],
  },
  workspace_settings: {
    summary: "Per-workspace reporting configuration such as reporting currency.",
    related: ["ledger_entries", "budget_lines", "accounts"],
  },
  account_metadata: {
    summary: "Per-account metadata such as liquidity classification.",
    related: ["accounts", "ledger_entries", "workspace_settings"],
  },
  exchange_rates: {
    summary: "Global FX rates used for query-time currency conversion.",
    related: ["workspace_settings", "ledger_entries", "budget_lines"],
  },
};

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);

const buildEntityHints = (relations: ReadonlyArray<AllowedRelationName>): EntityHints | undefined => {
  if (relations.length === 0) {
    return undefined;
  }

  const primaryName = relations[0];
  if (primaryName === undefined) {
    return undefined;
  }

  const relatedNames = Array.from(new Set([
    ...relations.filter((name) => name !== primaryName),
    ...ENTITY_METADATA[primaryName].related.filter((name) => name !== primaryName),
  ])).slice(0, 3);

  return {
    primary: {
      name: primaryName,
      summary: ENTITY_METADATA[primaryName].summary,
    },
    related: relatedNames.map((name) => ({
      name,
      summary: ENTITY_METADATA[name].summary,
    })),
  };
};

export const isUserSqlExecutionError = (error: unknown): boolean => {
  const pgError = error as PgError;
  if (typeof pgError.code !== "string" || pgError.code.length < 2) {
    return false;
  }

  return USER_SQL_ERROR_CLASSES.has(pgError.code.slice(0, 2));
};

export const getUserSqlExecutionMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return "The SQL statement could not be executed";
};

const isSchemaExplorationAttempt = (message: string): boolean =>
  /information_schema|pg_catalog|pg_/iu.test(message);

export const getSqlPolicyInstructions = (
  error: SqlPolicyError,
  apiBaseUrl: string,
): string => {
  if (error.code === "relation_not_allowed") {
    if (isSchemaExplorationAttempt(error.message)) {
      return `System catalogs are not queryable via /sql. Use ${apiBaseUrl}/schema to inspect allowed relations and columns, then query only those relations. Example: SELECT * FROM accounts LIMIT 0.`;
    }

    return `Relation is not exposed by policy. Use ${apiBaseUrl}/schema to see allowed relations, then retry. Workspace context must be set via /workspaces/{workspaceId}/select or X-Workspace-Id.`;
  }

  if (error.code === "unsupported_statement") {
    return "Use one SQL statement of type SELECT, WITH, INSERT, UPDATE, or DELETE. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "multiple_statements_not_allowed") {
    return "Send exactly one SQL statement per request. Remove semicolons and transaction wrappers.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "sql_comments_not_allowed") {
    return "Remove SQL comments (`--` and `/* ... */`) and retry.";
  }

  if (error.code === "quoted_identifiers_not_allowed") {
    return "Quoted identifiers are not allowed. Use unquoted lower_snake_case relation and column names.";
  }

  if (error.code === "dollar_quoted_strings_not_allowed") {
    return "Dollar-quoted strings are not allowed. Use regular single-quoted literals.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
};

export const runSql = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  workspaceId: string,
  sql: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const workspace = await getWorkspace(dependencies, authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const result = await executeExpenseSql(
    sql,
    async (validatedSql) => dependencies.withRestrictedTrustedIdentityContext(
      authenticated.identity,
      workspaceId,
      SQL_STATEMENT_TIMEOUT_MS,
      async (queryFn) => {
        const queryResult = await queryFn(validatedSql, []);
        return {
          rows: queryResult.rows as ReadonlyArray<Readonly<Record<string, unknown>>>,
          rowCount: queryResult.rowCount,
        };
      },
    ),
  );

  const entityHints = buildEntityHints(result.referencedRelations);

  return {
    rows: result.rows,
    rowCount: result.rowCount,
    workspace,
    ...(entityHints === undefined ? {} : { entityHints }),
    limits: {
      maxRows: MAX_SQL_ROWS,
      statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
    },
  };
};
