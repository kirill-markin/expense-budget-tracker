import {
  executeValidatedExpenseSql,
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlPolicyError,
  validateExpenseSql,
  validateReadOnlyExpenseSql,
  type AllowedRelationName,
  type ValidatedExpenseSql,
  type ValidatedReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { EntityHints, MachineApiDependencies, PgError, TrustedIdentityContext, WorkspaceSummary } from "./types.js";
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
    summary: "Append-only monthly Base budget rows with last-write-wins semantics.",
    related: ["workspace_settings"],
  },
  workspace_settings: {
    summary: "Per-workspace reporting configuration such as reporting currency.",
    related: ["ledger_entries", "budget_lines", "accounts"],
  },
  account_metadata: {
    summary: "Per-account metadata such as liquidity, personal/business classification, and regular/investment grouping.",
    related: ["accounts", "ledger_entries", "workspace_settings"],
  },
  fx_rates_raw: {
    summary: "Canonical raw FX source rates against the internal USD pivot currency.",
    related: ["fx_rates_daily", "workspace_settings", "ledger_entries"],
  },
  fx_rates_daily: {
    summary: "Query-ready daily all-pairs FX rates used by dashboards and reporting-currency conversion.",
    related: ["fx_rates_raw", "workspace_settings", "ledger_entries"],
  },
};

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);
const DEFAULT_USER_SQL_EXECUTION_MESSAGE = "The SQL statement could not be executed";

export class UserSqlExecutionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

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

const isSafeUserSqlDatabaseError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const pgError = error as PgError;
  if (typeof pgError.code !== "string" || pgError.code.length < 2) {
    return false;
  }

  return USER_SQL_ERROR_CLASSES.has(pgError.code.slice(0, 2));
};

const getDatabaseErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return DEFAULT_USER_SQL_EXECUTION_MESSAGE;
};

const throwUserSqlExecutionError = (error: unknown): never => {
  if (!isSafeUserSqlDatabaseError(error)) {
    throw error;
  }
  throw new UserSqlExecutionError(getDatabaseErrorMessage(error));
};

export const isUserSqlExecutionError = (error: unknown): error is UserSqlExecutionError =>
  error instanceof UserSqlExecutionError;

export const getUserSqlExecutionMessage = (error: unknown): string => {
  if (error instanceof UserSqlExecutionError && error.message !== "") {
    return error.message;
  }
  return DEFAULT_USER_SQL_EXECUTION_MESSAGE;
};

const isSchemaExplorationAttempt = (message: string): boolean =>
  /information_schema|pg_catalog|pg_/iu.test(message);

type MachineApiWorkspaceGetter = (
  dependencies: MachineApiDependencies,
  identity: TrustedIdentityContext["identity"],
  workspaceId: string,
) => Promise<WorkspaceSummary | null>;

export type ExistingWorkspaceGetter = (
  identity: TrustedIdentityContext["identity"],
  workspaceId: string,
) => Promise<WorkspaceSummary | null>;

type RestrictedContextRunner = MachineApiDependencies["withRestrictedTrustedIdentityContext"];

export const getSqlPolicyInstructions = (
  error: SqlPolicyError,
  apiBaseUrl: string,
): string => {
  if (error.code === "relation_not_allowed") {
    if (isSchemaExplorationAttempt(error.message)) {
      return `System catalogs are not queryable via /sql. Use ${apiBaseUrl}/schema to inspect allowed relations, columns, and any agent hints, then query only those relations. Example: SELECT * FROM accounts LIMIT 0.`;
    }

    return `Relation is not exposed by policy. Use ${apiBaseUrl}/schema to see allowed relations, columns, and any agent hints, then retry. Workspace context must be set via /workspaces/{workspaceId}/select or X-Workspace-Id.`;
  }

  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata.`;
  }

  if (error.code === "recursive_cte_search_cycle_not_allowed") {
    return "Recursive CTE SEARCH and CYCLE clauses are not supported in restricted SQL. Rewrite the CTE without those clauses.";
  }

  if (error.code === "unsupported_statement") {
    return "Use only SELECT, WITH, INSERT, UPDATE, or DELETE. /sql/query and /sql/execute accept exactly one statement; legacy /sql accepts atomic multi-statement scripts. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "single_statement_required") {
    return "Send exactly one SQL statement to /sql/query or /sql/execute. Use legacy /sql only when an atomic multi-statement script is required.";
  }

  if (error.code === "sql_script_too_long" || error.code === "too_many_sql_statements") {
    return error.message;
  }

  if (
    error.code === "mutation_statement_row_limit_exceeded"
    || error.code === "mutation_request_row_limit_exceeded"
  ) {
    return `${error.message}. Narrow the mutation or split it into sequential requests of at most ${MAX_SQL_MUTATION_ROWS} affected rows each.`;
  }

  if (error.code === "read_only_sql_required") {
    return "Use /sql/query for exactly one SELECT or WITH...SELECT statement without data-modifying CTEs. Send one approved write statement to /sql/execute.";
  }

  if (error.code === "on_conflict_not_allowed") {
    return "ON CONFLICT is not supported in restricted SQL. Use explicit SELECT first, then INSERT or UPDATE as separate steps.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "function_calls_not_allowed") {
    return "Only allowlisted functions are supported in restricted SQL: SUM, COUNT, MIN, MAX, AVG, and COALESCE. Query only the published tables and views directly, use ILIKE instead of LOWER(...) for case-insensitive text search, and use explicit date ranges instead of NOW() or DATE_TRUNC().";
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

  if (error.code === "escape_string_literals_not_allowed") {
    return "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
};

const executeSqlWithWorkspaceGetter = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  workspaceGetter: ExistingWorkspaceGetter,
  runInRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const workspace = await workspaceGetter(authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const result = await runInRestrictedContext(
    authenticated.identity,
    workspaceId,
    SQL_STATEMENT_TIMEOUT_MS,
    async (queryFn) => executeValidatedExpenseSql(
      validated,
      async (request) => {
        try {
          const queryResult = await queryFn(request.sql, request.params);
          return {
            command: queryResult.command,
            rows: queryResult.rows as ReadonlyArray<Readonly<Record<string, unknown>>>,
            rowCount: queryResult.rowCount,
          };
        } catch (error) {
          throwUserSqlExecutionError(error);
        }
      },
    ),
  );

  return {
    statements: result.statements.map((statement) => {
      const entityHints = buildEntityHints(statement.referencedRelations);
      return {
        sql: statement.sql,
        command: statement.command,
        rows: statement.rows,
        rowCount: statement.rowCount,
        returnedRowCount: statement.returnedRowCount,
        totalRowCount: statement.totalRowCount,
        truncated: statement.truncated,
        referencedRelations: statement.referencedRelations,
        ...(entityHints === undefined ? {} : { entityHints }),
      };
    }),
    workspace,
    limits: {
      maxRows: MAX_SQL_ROWS,
      statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
    },
  };
};

export const runSqlWithWorkspaceGetter = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  sql: string,
  workspaceGetter: MachineApiWorkspaceGetter,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validateExpenseSql(sql),
    (identity, resolvedWorkspaceId) => workspaceGetter(
      dependencies,
      identity,
      resolvedWorkspaceId,
    ),
    dependencies.withRestrictedTrustedIdentityContext,
  );

export const runReadOnlySqlWithWorkspaceGetter = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  sql: string,
  workspaceGetter: MachineApiWorkspaceGetter,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validateReadOnlyExpenseSql(sql),
    (identity, resolvedWorkspaceId) => workspaceGetter(
      dependencies,
      identity,
      resolvedWorkspaceId,
    ),
    dependencies.withReadOnlyRestrictedTrustedIdentityContext,
  );

export const runSqlWithServices = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  workspaceGetter: ExistingWorkspaceGetter,
  runInRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    workspaceGetter,
    runInRestrictedContext,
  );

export const runReadOnlySqlWithServices = async (
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedReadOnlyExpenseSql,
  workspaceGetter: ExistingWorkspaceGetter,
  runInReadOnlyRestrictedContext: RestrictedContextRunner,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    workspaceGetter,
    runInReadOnlyRestrictedContext,
  );

export const runSql = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedExpenseSql,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    (identity, resolvedWorkspaceId) => getWorkspace(
      dependencies,
      identity,
      resolvedWorkspaceId,
    ),
    dependencies.withRestrictedTrustedIdentityContext,
  );

export const runReadOnlySql = async (
  dependencies: MachineApiDependencies,
  authenticated: TrustedIdentityContext,
  workspaceId: string,
  validated: ValidatedReadOnlyExpenseSql,
): Promise<Readonly<Record<string, unknown>> | null> =>
  executeSqlWithWorkspaceGetter(
    authenticated,
    workspaceId,
    validated,
    (identity, resolvedWorkspaceId) => getWorkspace(
      dependencies,
      identity,
      resolvedWorkspaceId,
    ),
    dependencies.withReadOnlyRestrictedTrustedIdentityContext,
  );
