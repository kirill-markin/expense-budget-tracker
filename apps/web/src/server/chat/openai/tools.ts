import { tool, type RunContext } from "@openai/agents";
import { z } from "zod";
import { withUserContext } from "@/server/db";

export type AgentContext = Readonly<{
  userId: string;
  workspaceId: string;
}>;

const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 10_000;

const isSelectOnly = (sql: string): boolean => {
  const first = sql.trimStart().split(/\s/)[0]?.toUpperCase();
  return first === "SELECT" || first === "WITH";
};

export const pgQueryTool = tool({
  name: "query_database",
  description: `Execute a read-only SQL query against the expense tracker database.
Tables: ledger_entries (ts, account_id, amount, currency, kind, category, counterparty, note),
        budget_lines (budget_month, direction, category, planned_value, currency),
        exchange_rates (base_currency, quote_currency, rate_date, rate),
        workspace_settings (reporting_currency, filtered_categories),
        account_metadata (account_id, liquidity).
View: accounts (account_id, currency, inserted_at).
kind is one of: 'income', 'spend', 'transfer'.
All data is workspace-scoped via RLS. Use standard SQL.`,
  parameters: z.object({
    sql: z.string().describe("SELECT query to execute"),
  }),
  execute: async (
    input: { sql: string },
    runContext?: RunContext<AgentContext>,
  ): Promise<string> => {
    if (runContext === undefined) {
      throw new Error("pgQueryTool: missing run context");
    }

    const { userId, workspaceId } = runContext.context;

    if (!isSelectOnly(input.sql)) {
      throw new Error("Only SELECT or WITH queries are allowed");
    }

    const result = await withUserContext(userId, workspaceId, async (queryFn) => {
      await queryFn(
        `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`,
        [],
      );
      return queryFn(input.sql, []);
    });

    const rows = result.rows.slice(0, MAX_ROWS);
    return JSON.stringify(rows);
  },
});
