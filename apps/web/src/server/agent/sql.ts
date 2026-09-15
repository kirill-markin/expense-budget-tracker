/**
 * Agent-facing SQL execution on app.* using the shared SQL policy.
 */
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
  applySqlResultCharBudget,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";
import { type AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type AgentSqlStatementResult = Readonly<{
  sql: string;
  command: string;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

export type AgentSqlResult = Readonly<{
  statements: ReadonlyArray<AgentSqlStatementResult>;
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
  // instruction text, so the emitted body is that much larger than the budget.
  const statements = applySqlResultCharBudget(
    entries,
    (candidate) => JSON.stringify({
      statements: candidate,
      workspace,
      limits,
    }).length,
  );

  return {
    statements,
    workspace,
    limits,
  };
};
