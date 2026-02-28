import type { ContentPart } from "@/server/chat/types";
import { withUserContext } from "@/server/db";

export const MAX_ROWS = 100;
export const STATEMENT_TIMEOUT_MS = 10_000;

export const SYSTEM_INSTRUCTIONS = `You are a financial assistant for an expense tracker app.
You have access to the user's expense database via the query_database tool.
You can read data (SELECT) and write data (INSERT, UPDATE, DELETE) — for example, adding transactions, updating budgets, or deleting entries.
Before any write operation (INSERT, UPDATE, DELETE), you MUST first describe the exact changes you plan to make and wait for the user's explicit confirmation. Only execute the write after the user approves. Read queries (SELECT) do not require confirmation.
When inserting rows, always include the workspace_id column.
When the user asks about their finances, write SQL queries to fetch the data.
Present results clearly with formatting.
Be concise and direct. If a query returns no data, say so clearly.
You also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information when the user's question goes beyond the data in the database.`;

export const TOOL_DESCRIPTION = `Execute a SQL statement (SELECT, INSERT, UPDATE, DELETE) against the expense tracker database.
Tables: ledger_entries (ts, account_id, amount, currency, kind, category, counterparty, note, workspace_id),
        budget_lines (budget_month, direction, category, planned_value, currency, workspace_id),
        exchange_rates (base_currency, quote_currency, rate_date, rate),
        workspace_settings (reporting_currency, filtered_categories),
        account_metadata (account_id, liquidity, workspace_id).
View: accounts (account_id, currency, inserted_at).
kind is one of: 'income', 'spend', 'transfer'.
All data is workspace-scoped via RLS. INSERTs must include workspace_id. Use standard SQL.`;

const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
]);

export const isDml = (sql: string): boolean => {
  const first = sql.trimStart().split(/\s/)[0]?.toUpperCase();
  return first !== undefined && ALLOWED_FIRST_KEYWORDS.has(first);
};

export type QueryResult = Readonly<{
  json: string;
}>;

export const execQuery = async (
  sql: string,
  userId: string,
  workspaceId: string,
): Promise<QueryResult> => {
  if (!isDml(sql)) {
    throw new Error("Only SELECT, WITH, INSERT, UPDATE, DELETE statements are allowed");
  }

  const result = await withUserContext(userId, workspaceId, async (queryFn) => {
    await queryFn(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`,
      [],
    );
    return queryFn(sql, []);
  });

  const rows = result.rows.slice(0, MAX_ROWS);
  if (rows.length > 0) {
    return { json: JSON.stringify(rows) };
  }
  return { json: JSON.stringify({ rowCount: result.rowCount }) };
};

export const extractText = (content: ReadonlyArray<ContentPart>): string =>
  content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");

export const summarizeContent = (content: ReadonlyArray<ContentPart>): string => {
  const parts: Array<string> = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push(p.text);
    } else if (p.type === "image") {
      parts.push("[attached image]");
    } else if (p.type === "file") {
      parts.push(`[attached file: ${p.fileName}]`);
    }
  }
  return parts.join("\n");
};
