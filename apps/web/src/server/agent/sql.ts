/**
 * Agent-facing SQL execution on app.* using the shared SQL policy.
 */
import {
  createSqlExecutionDeadline,
  executeValidatedExpenseSqlWithinDeadline,
  getAllowedRelationNames,
  MAX_SQL_RESULT_CHARS,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  type AllowedRelationName,
  type ExecutedExpenseSql,
  type SqlExecutionDeadline,
  type ValidatedExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  withReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
} from "@/server/db";
import {
  DbTransactionOutcomeUnknownError,
  type QueryFn,
} from "@/server/db/contextRunner";
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

export type AgentSqlDependencies = Readonly<{
  getWorkspaceForTrustedIdentity: typeof getWorkspaceForTrustedIdentity;
  withReadOnlyRestrictedTrustedIdentityContext: typeof withReadOnlyRestrictedTrustedIdentityContext;
  withRestrictedTrustedIdentityContext: typeof withRestrictedTrustedIdentityContext;
  now: () => number;
}>;

const DEFAULT_AGENT_SQL_DEPENDENCIES: AgentSqlDependencies = {
  getWorkspaceForTrustedIdentity,
  withReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
  now: Date.now,
};

type PgError = Error & Readonly<{
  code?: string;
}>;

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "22",
  "23",
  "42",
]);

// A database failure the caller's own statement provokes without any defect on
// this side: class 40 is a deadlock or serialization failure between concurrent
// scripts. Class 25 is deliberately absent with the infrastructure SQLSTATEs
// such as 57P01, 53300 and 08006: 25006 is equally how the read-only
// transaction reports a write that should never have reached it and how a
// read-only database refuses every mutation, so it keeps paging.
const CLIENT_PROVOKED_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "40",
]);

// PostgreSQL cancelled a statement at the per-command statement_timeout set from
// the deadline still left. The deadline itself is only checked between
// commands, so a single slow statement expires it this way rather than through
// SqlExecutionDeadlineError.
const STATEMENT_TIMEOUT_ERROR_CODE = "57014";

// The statement_timeout the COMMIT after the script's last command runs under,
// for the reason CHAT_SQL_COMMIT_TIMEOUT_MS in apps/web/src/server/chat/shared.ts
// gives.
const AGENT_SQL_COMMIT_TIMEOUT_MS = 10_000;

export const getAgentSqlAllowedRelations = (): ReadonlyArray<AllowedRelationName> =>
  getAllowedRelationNames();

const getSqlErrorClass = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { code } = error as PgError;
  if (typeof code !== "string" || code.length < 2) {
    return null;
  }
  return code.slice(0, 2);
};

export const isUserSqlExecutionError = (error: unknown): boolean => {
  const errorClass = getSqlErrorClass(error);
  return errorClass !== null && USER_SQL_ERROR_CLASSES.has(errorClass);
};

export const isClientProvokedSqlError = (error: unknown): boolean => {
  const errorClass = getSqlErrorClass(error);
  return errorClass !== null && CLIENT_PROVOKED_SQL_ERROR_CLASSES.has(errorClass);
};

export const isSqlStatementTimeoutError = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && (error as PgError).code === STATEMENT_TIMEOUT_ERROR_CODE;

export const getUserSqlExecutionMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "The SQL statement could not be executed";
};

const AGENT_SQL_MUTATION_OUTCOME_UNKNOWN_MESSAGE = "The SQL mutation transaction outcome is unknown";

/**
 * A mutating statement was issued to the database inside a transaction that
 * ended without a known outcome, so its writes may already be durable and the
 * caller must verify the data instead of retrying. A transaction that issued no
 * mutating statement, such as a workspace lookup, never raises this.
 */
export class AgentSqlMutationOutcomeUnknownError extends Error {
  public constructor(cause: DbTransactionOutcomeUnknownError) {
    super(AGENT_SQL_MUTATION_OUTCOME_UNKNOWN_MESSAGE, { cause });
    this.name = "AgentSqlMutationOutcomeUnknownError";
  }
}

const hasMutatingStatement = (validated: ValidatedExpenseSql): boolean =>
  validated.statements.some((statement) => statement.isMutating);

// Every command is bounded twice: the deadline caps the whole script client-side
// before each command starts, and each command also carries the budget still
// left as its own server-side statement_timeout. Both restricted roles lack
// EXECUTE on set_config() (db/migrations/0012_restrict_set_config.sql), so the
// timeout is set with SET LOCAL, which takes no bind parameters; every
// interpolated value is a positive safe integer, the one
// getRemainingSqlExecutionMs() returns or the fixed commit allowance. Database
// errors propagate unwrapped for the route to classify.
const runAgentSqlWithinDeadline = async (
  queryFn: QueryFn,
  validated: ValidatedExpenseSql,
  deadline: SqlExecutionDeadline,
  onCommandIssued: (sql: string) => void,
): Promise<ExecutedExpenseSql> => {
  const executed = await executeValidatedExpenseSqlWithinDeadline(
    validated,
    deadline,
    async (request, remainingStatementTimeoutMs) => {
      await queryFn(
        `SET LOCAL statement_timeout = ${String(remainingStatementTimeoutMs)}`,
        [],
      );
      onCommandIssued(request.sql);
      return queryFn(request.sql, request.params);
    },
  );

  await queryFn(
    `SET LOCAL statement_timeout = ${String(AGENT_SQL_COMMIT_TIMEOUT_MS)}`,
    [],
  );
  return executed;
};

export const executeAgentSqlWithDependencies = async (
  authenticated: AgentAuthenticatedRequest,
  workspaceId: string,
  validated: ValidatedExpenseSql,
  dependencies: AgentSqlDependencies,
): Promise<AgentSqlResult | null> => {
  const workspace = await dependencies.getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const deadline = createSqlExecutionDeadline(SQL_STATEMENT_TIMEOUT_MS, dependencies.now);
  // One mutating statement keeps the whole script, its reads included, in one
  // writable transaction under api_sql_executor. A script without one runs in a
  // repeatable-read read-only transaction under api_sql_reader, which keeps it
  // read-only independently of the validator that accepted it.
  const runInRestrictedContext: AgentSqlDependencies["withRestrictedTrustedIdentityContext"] = hasMutatingStatement(validated)
    ? dependencies.withRestrictedTrustedIdentityContext
    : dependencies.withReadOnlyRestrictedTrustedIdentityContext;
  const mutatingSql: ReadonlySet<string> = new Set(
    validated.statements
      .filter((statement) => statement.isMutating)
      .map((statement) => statement.sql),
  );
  let mutationIssued = false;
  let result: ExecutedExpenseSql;
  try {
    result = await runInRestrictedContext(
      authenticated.identity,
      workspaceId,
      SQL_STATEMENT_TIMEOUT_MS,
      async (queryFn) => runAgentSqlWithinDeadline(
        queryFn,
        validated,
        deadline,
        (issuedSql) => {
          if (mutatingSql.has(issuedSql)) {
            mutationIssued = true;
          }
        },
      ),
    );
  } catch (error) {
    // This transaction is the only one that runs the script, and only a
    // mutating statement it already issued can have left writes behind. Any
    // other unknown outcome stays the failure that caused it.
    if (error instanceof DbTransactionOutcomeUnknownError) {
      if (!mutationIssued) {
        throw error.originalError;
      }
      throw new AgentSqlMutationOutcomeUnknownError(error);
    }
    throw error;
  }

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

export const executeAgentSql = async (
  authenticated: AgentAuthenticatedRequest,
  workspaceId: string,
  validated: ValidatedExpenseSql,
): Promise<AgentSqlResult | null> =>
  executeAgentSqlWithDependencies(authenticated, workspaceId, validated, DEFAULT_AGENT_SQL_DEPENDENCIES);
