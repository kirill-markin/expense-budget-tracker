/**
 * Agent-facing SQL execution on app.* using the shared SQL policy.
 */
import { getAgentSchemaHints, type AgentSchemaHints } from "@expense-budget-tracker/agent-shared";
import {
  executeValidatedExpenseSql,
  getAllowedRelationNames,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  type AllowedRelationName,
  type ValidatedExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { withRestrictedTrustedIdentityContext } from "@/server/db";
import {
  applyStagedSqlResultCharBudget,
  type BudgetedSqlShrinkStage,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";
import { type AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type AgentSqlRelationHints = Readonly<Partial<Record<AllowedRelationName, AgentSchemaHints>>>;

type AgentSqlStatementResult = Readonly<{
  sql: string;
  command: string;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
  // Rows are dropped first; a shrink stage sheds this only once no row prefix
  // fits, not even zero rows, so a shrunk statement omits it and
  // GET /api/agent/schema still serves the same hints.
  hints?: AgentSqlRelationHints;
}>;

export type AgentSqlResult = Readonly<{
  statements: ReadonlyArray<AgentSqlStatementResult>;
  // Whether the character budget had to shed the per-statement hints. Always
  // present, so the response states that the hints are complete as plainly as it
  // states that they are gone, and the measured payload is the emitted one.
  hintsDropped: boolean;
  workspace: Readonly<{
    workspaceId: string;
    name: string;
  }>;
  limits: Readonly<{
    maxRows: number;
    maxResultChars: number;
    statementTimeoutMs: number;
  }>;
}>;

type PgError = Error & Readonly<{
  code?: string;
}>;

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "22",
  "23",
  "42",
]);

const buildRelationHints = (
  relations: ReadonlyArray<AllowedRelationName>,
): AgentSqlRelationHints => Object.fromEntries(relations.map((name) => {
  const hints = getAgentSchemaHints(name);
  if (hints === undefined) {
    throw new Error(`Missing agent schema hints for relation ${name}`);
  }
  return [name, hints] as const;
}));

// Static per-relation documentation the caller can read again from
// GET /api/agent/schema, and the whole shared hints object for every relation a
// statement touched is a fixed per-statement cost no row cut can pay for. So it
// is first in this surface's shrink-stage list, the way apps/sql-api/src/
// machineApi/sqlService.ts lists relation hints first. Rows are still dropped
// first: this stage runs only once no row prefix fits, not even zero rows. It is
// a discrete stage over the whole payload, never a rule inside the search.
const WITHOUT_HINTS_STAGE: BudgetedSqlShrinkStage<AgentSqlStatementResult> = {
  build: (entry) => ({
    ...entry,
    statement: {
      sql: entry.statement.sql,
      command: entry.statement.command,
      rows: entry.statement.rows,
      rowCount: entry.statement.rowCount,
      returnedRowCount: entry.statement.returnedRowCount,
      totalRowCount: entry.statement.totalRowCount,
      truncated: entry.statement.truncated,
      referencedRelations: entry.statement.referencedRelations,
    },
  }),
  shrunk: true,
};

export const getAgentSqlAllowedRelations = (): ReadonlyArray<AllowedRelationName> =>
  getAllowedRelationNames();

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

export const executeAgentSql = async (
  authenticated: AgentAuthenticatedRequest,
  workspaceId: string,
  validated: ValidatedExpenseSql,
): Promise<AgentSqlResult | null> => {
  const workspace = await getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const result = await withRestrictedTrustedIdentityContext(
    authenticated.identity,
    workspaceId,
    SQL_STATEMENT_TIMEOUT_MS,
    async (queryFn) => executeValidatedExpenseSql(
      validated,
      async (request) => queryFn(request.sql, request.params),
    ),
  );

  const entries = result.statements.map((
    statement,
  ): BudgetedSqlStatementEntry<AgentSqlStatementResult> => ({
    statement: {
      sql: statement.sql,
      command: statement.command,
      rows: statement.rows,
      rowCount: statement.rowCount,
      returnedRowCount: statement.returnedRowCount,
      totalRowCount: statement.totalRowCount,
      truncated: statement.truncated,
      referencedRelations: statement.referencedRelations,
      hints: buildRelationHints(statement.referencedRelations),
    },
    isMutating: statement.isMutating,
  }));
  const limits: AgentSqlResult["limits"] = {
    maxRows: MAX_SQL_ROWS,
    maxResultChars: MAX_SQL_RESULT_CHARS,
    statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
  };

  // Measured against the result object this function returns, in the shape the
  // route emits it. The route wraps it in the success envelope and its
  // instruction text, so the emitted body is that much larger than the budget;
  // rows are what this sheds first, then the per-statement hints.
  const budgeted = applyStagedSqlResultCharBudget(
    entries,
    (candidate, hintsDropped) => JSON.stringify({
      statements: candidate,
      hintsDropped,
      workspace,
      limits,
    }).length,
    [WITHOUT_HINTS_STAGE],
  );

  return {
    statements: budgeted.statements,
    hintsDropped: budgeted.shrunk,
    workspace,
    limits,
  };
};
