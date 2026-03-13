/**
 * Agent-facing SQL execution on app.* using the shared SQL policy.
 */
import {
  executeExpenseSql,
  getAllowedRelationNames,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  type AllowedRelationName,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { withRestrictedTrustedIdentityContext } from "@/server/db";
import { type AgentAuthenticatedRequest } from "@/server/agentApiKeyAuth";
import { getWorkspaceForTrustedIdentity } from "@/server/workspaces";

type EntityHint = Readonly<{
  name: AllowedRelationName;
  summary: string;
}>;

export type EntityHints = Readonly<{
  primary: EntityHint;
  related: ReadonlyArray<EntityHint>;
}>;

export type AgentSqlResult = Readonly<{
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  workspace: Readonly<{
    workspaceId: string;
    name: string;
  }>;
  entityHints?: EntityHints;
  limits: Readonly<{
    maxRows: number;
    statementTimeoutMs: number;
  }>;
}>;

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

type PgError = Error & Readonly<{
  code?: string;
}>;

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "22",
  "23",
  "42",
]);

const buildEntityHints = (relations: ReadonlyArray<AllowedRelationName>): EntityHints | undefined => {
  if (relations.length === 0) {
    return undefined;
  }

  const primaryName = relations[0];
  if (primaryName === undefined) {
    return undefined;
  }
  const primaryMetadata = ENTITY_METADATA[primaryName];

  const relatedNames = Array.from(new Set([
    ...relations.filter((name) => name !== primaryName),
    ...primaryMetadata.related.filter((name) => name !== primaryName),
  ])).slice(0, 3);
  const related = relatedNames.map((name) => ({
    name,
    summary: ENTITY_METADATA[name].summary,
  }));

  return {
    primary: {
      name: primaryName,
      summary: primaryMetadata.summary,
    },
    related,
  };
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
  sql: string,
): Promise<AgentSqlResult | null> => {
  const workspace = await getWorkspaceForTrustedIdentity(authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const result = await executeExpenseSql(
    sql,
    async (validatedSql) => withRestrictedTrustedIdentityContext(
      authenticated.identity,
      workspaceId,
      SQL_STATEMENT_TIMEOUT_MS,
      async (queryFn) => queryFn(validatedSql, []),
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
