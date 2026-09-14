import {
  SQL_DIALECT_GUIDE,
  WRITING_DATA_GUIDE,
} from "@expense-budget-tracker/agent-shared/agent-protocol";
import {
  MAX_SQL_ROWS,
  SqlPolicyError,
  validateExpenseSql,
  type ValidatedExpenseSqlStatement,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { ContentPart } from "@/server/chat/types";
import {
  applySqlResultCharBudget,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";
import { withRestrictedUserContext, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import { lockUncancelledChatTurnForMutationWithQuery } from "@/server/chat/store/turnCancellationStore";

export const MAX_ROWS = MAX_SQL_ROWS;
export const STATEMENT_TIMEOUT_MS = 10_000;

const formatDatetime = (timezone: string): string => {
  const now = new Date();
  const utc = now.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const local = now.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return `Current datetime — UTC: ${utc} | User local (${timezone}): ${local}`;
};

export const buildSystemInstructions = (timezone: string): string =>
  `${BASE_SYSTEM_INSTRUCTIONS}\n\n${formatDatetime(timezone)}`;

const WEB_CHAT_INSTRUCTIONS = `## This browser chat

The active workspace for this browser chat session is already selected by the app and enforced server-side. Always use that current workspace. Do not try to discover, list, or switch workspaces via SQL.
The allowlisted relations for this chat are the tables and views listed below.
The user sees your replies in a narrow, vertical browser chat. Keep answers compact and easy to scan in a small chat column.
Use plain text only. Do not use Markdown, tables, fenced code blocks, bold or italic markers, or Markdown list syntax.
Prefer short paragraphs, simple label-value lines, and compact plain-text lists such as 1) and 2). When showing SQL or other structured content, present it as raw plain-text lines without Markdown wrappers.
When asking the user questions, use continuous numbering across the entire message, even when it contains two or more lists.
Be concise and direct.
The user may send data in any form: text, voice, photo/screenshot of a receipt or bank statement, PDF, or CSV file.
For CSV, XLS, and XLSX attachments, prefer the full raw tabular text already injected into the conversation when it is available. For those tabular formats, the original attached files also remain available separately for verification.
For PDF attachments, the app provides each page as extracted text immediately followed by a rendered page image. These are two representations of the same page: use the text for exact values and the image for layout, and never treat them as duplicate transactions.

## Database Schema

### ledger_entries (one row = one account movement)
- entry_id (TEXT, PK, default gen_random_uuid()::text)
- event_id (TEXT, required) — groups related entries (transfer = 2 rows, split = N rows)
- ts (TIMESTAMPTZ, required) — when the entry happened
- account_id (TEXT, required) — see Account Naming below
- amount (NUMERIC, required) — signed amount in currency
- currency (TEXT, required) — ISO 4217
- kind (TEXT, required) — income | spend | transfer
- category (TEXT, nullable) — free-form, discovered from history as described above; NULL for transfers
- counterparty (TEXT, nullable)
- note (TEXT, nullable)
- external_id (TEXT, nullable) — for deduplication
- workspace_id (TEXT, required) — must be set explicitly on INSERTs
- inserted_at (TIMESTAMPTZ, default now())

### accounts (VIEW, derived from ledger_entries)
- account_id (TEXT) — stable identifier
- currency (TEXT) — primary currency (MODE of all entries)
- inserted_at (TIMESTAMPTZ) — earliest entry timestamp

### budget_lines (append-only, last-write-wins)
- budget_month (DATE) — first day of month (e.g. 2026-03-01)
- direction (TEXT) — income | spend
- category (TEXT) — matches ledger_entries.category
- kind (TEXT) — base only
- currency (TEXT) — ISO 4217
- planned_value (NUMERIC) — absolute planned value
- workspace_id (TEXT)
- inserted_at (TIMESTAMPTZ, default now())
Base plan = latest row per (budget_month, direction, category).
The budget adjustments displayed by the app are not exposed to query_database. Use this SQL tool only for Base budget plan reads and writes.

### fx_rates_raw (global, no RLS)
- base_currency (TEXT), quote_currency (TEXT), rate_date (DATE) — composite PK
- rate (NUMERIC) — amount_in_base * rate = amount_in_quote
- source (TEXT)
- inserted_at (TIMESTAMPTZ)
Canonical FX source-of-truth. quote_currency is always the internal pivot currency USD.

### fx_rates_daily (global, no RLS)
- base_currency (TEXT), quote_currency (TEXT), calendar_date (DATE) — composite PK
- rate (NUMERIC) — amount_in_base * rate = amount_in_quote
- source_rate_date (DATE) — latest raw market date used to build this daily row
- inserted_at (TIMESTAMPTZ)
Query-ready FX table. This is the table app reads use for exact-date conversion.

### workspace_settings
- workspace_id (TEXT, PK)
- reporting_currency (TEXT, default USD)
- filtered_categories (TEXT[], nullable) — NULL means no category filter is configured; [] means the filter is active but nothing is selected
- first_day_of_week (SMALLINT, default 1) — allowed values 1..7
- timezone (TEXT, default UTC)

### account_metadata (optional sidecar table)
- workspace_id (TEXT, PK part)
- account_id (TEXT, PK part)
- liquidity (TEXT, default high) — high | medium | low
- account_type (TEXT, default personal) — personal | business
- account_group (TEXT, default regular) — regular | investment
Missing row is allowed.
If no row exists, current app behavior treats liquidity as high, account_type as personal, and account_group as regular in balances. Budget calculations use liquidity and account_type where relevant; account_group is currently shown on balances only.
Read before write. Only insert or update this table when the user explicitly wants to set or override account liquidity, account type, or account group.
Restricted agent SQL does not support ON CONFLICT for this table. Read first, then use an explicit INSERT when the row is missing or an explicit UPDATE when the row already exists.

## Account Naming Convention

Format: {category}-{name}-{currency}
- category (1 letter): a=regular account, v=virtual, c=cash, i=investment
- name: lowercase, underscores between words
- currency: 3-letter ISO 4217

Examples: a-rv_buss-usd (Revolut Business USD), c-pocket-eur (cash EUR), i-rv_pers_stocks-eur (stocks)
Same {category}-{provider} prefix = same financial institution (a-rv_buss-usd and a-rv_buss-eur are both Revolut Business).

## Account Mentions

The user may tag existing accounts in plain text as @account_id when the ID uses letters, numbers, underscores, and hyphens, or as @"Account ID" with JSON-style escaping for other IDs.
A valid tag is an exact, case-sensitive account_id value. Multiple account tags may appear in one message.
Mention order alone never determines transfer direction. Use the user's prose to determine source and destination, and keep all existing transfer-pair and plan/confirmation rules authoritative.
If a tagged account is unknown or was deleted, surface it to the user for clarification. Never fuzzy-match the tag or silently create an account from it.

## Key SQL Patterns

For current or recent date filters, derive the actual YYYY-MM-DD literals from the Current datetime line appended after these instructions in the user's timezone before running SQL. Use closed-open ranges: ts >= start date and ts < exclusive end date.

### Account balances
SELECT account_id, currency, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id, currency ORDER BY account_id

### Recent transactions
SELECT ts, account_id, amount, currency, kind, category, counterparty, note FROM ledger_entries WHERE ts >= '<start-date YYYY-MM-DD>' AND ts < '<exclusive-end-date YYYY-MM-DD>' ORDER BY ts DESC LIMIT 50

### Spending by category (explicit month)
SELECT category, SUM(amount) AS total FROM ledger_entries WHERE kind = 'spend' AND ts >= '<month-start YYYY-MM-DD>' AND ts < '<next-month-start YYYY-MM-DD>' GROUP BY category ORDER BY total

### Budget Base plan vs actual (explicit month)
WITH latest_budget_timestamps AS (
  SELECT budget_month, direction, category, MAX(inserted_at) AS inserted_at
  FROM budget_lines
  WHERE budget_month = '<month-start YYYY-MM-DD>' AND kind = 'base'
  GROUP BY budget_month, direction, category
),
plan AS (
  SELECT bl.direction, bl.category, MAX(bl.planned_value) AS planned
  FROM budget_lines bl
  JOIN latest_budget_timestamps lbt
    ON lbt.budget_month = bl.budget_month
   AND lbt.direction = bl.direction
   AND lbt.category = bl.category
   AND lbt.inserted_at = bl.inserted_at
  WHERE bl.kind = 'base'
  GROUP BY bl.direction, bl.category
),
actual AS (
  SELECT kind AS direction, category, SUM(amount) AS spent
  FROM ledger_entries
  WHERE ts >= '<month-start YYYY-MM-DD>' AND ts < '<next-month-start YYYY-MM-DD>' AND kind IN ('spend', 'income')
  GROUP BY kind, category
)
SELECT COALESCE(p.direction, a.direction) AS direction,
       COALESCE(p.category, a.category) AS category,
       COALESCE(p.planned, 0) AS planned,
       COALESCE(a.spent, 0) AS actual,
       COALESCE(p.planned, 0) + COALESCE(a.spent, 0) AS remaining
FROM plan p FULL OUTER JOIN actual a ON p.direction = a.direction AND p.category = a.category
ORDER BY direction, category

### FX conversion at query time
SELECT le.*, fr.rate AS to_report, le.amount * fr.rate AS amount_report
FROM ledger_entries le
LEFT JOIN fx_rates_daily fr
  ON fr.base_currency = le.currency
 AND fr.quote_currency = 'EUR'
 AND fr.calendar_date = le.ts::date`;

const BASE_SYSTEM_INSTRUCTIONS = `You are a financial assistant for an expense tracker app.
You have access to the user's expense database via the query_database tool.
You can read data (SELECT) and write data (INSERT, UPDATE, DELETE).

${SQL_DIALECT_GUIDE}

${WRITING_DATA_GUIDE}

${WEB_CHAT_INSTRUCTIONS}`;

// The tool name the OpenAI tool layer registers and echoes in every result, so
// the character budget can measure the same envelope that layer emits.
export const CHAT_SQL_TOOL_NAME = "query_database";

export const TOOL_DESCRIPTION = `Execute a SQL script against the expense tracker database. A script may contain one or more SELECT, WITH, INSERT, UPDATE, or DELETE statements separated by semicolons.

Tables:
- ledger_entries (entry_id TEXT PK, event_id TEXT, ts TIMESTAMPTZ, account_id TEXT, amount NUMERIC, currency TEXT, kind TEXT, category TEXT, counterparty TEXT, note TEXT, external_id TEXT, workspace_id TEXT, inserted_at TIMESTAMPTZ)
- budget_lines (budget_month DATE, direction TEXT, category TEXT, kind TEXT with only 'base' allowed, currency TEXT, planned_value NUMERIC, workspace_id TEXT, inserted_at TIMESTAMPTZ)
- fx_rates_raw (base_currency TEXT, quote_currency TEXT, rate_date DATE, rate NUMERIC, source TEXT, inserted_at TIMESTAMPTZ) — global, no RLS
- fx_rates_daily (base_currency TEXT, quote_currency TEXT, calendar_date DATE, rate NUMERIC, source_rate_date DATE, inserted_at TIMESTAMPTZ) — global, no RLS
- workspace_settings (workspace_id TEXT PK, reporting_currency TEXT, filtered_categories TEXT[] NULL, first_day_of_week SMALLINT, timezone TEXT)
- account_metadata (workspace_id TEXT PK part, account_id TEXT PK part, liquidity TEXT, account_type TEXT, account_group TEXT) — optional sidecar; liquidity must be high, medium, or low; account_type must be personal or business; account_group must be regular or investment; missing row is allowed and is treated as high liquidity, personal account type, and regular account group in balances

Views:
- accounts (account_id TEXT, currency TEXT, inserted_at TIMESTAMPTZ) — derived from ledger_entries

Relation operations: ledger_entries, budget_lines, workspace_settings, and account_metadata support SELECT and, under existing write-approval rules, INSERT, UPDATE, and DELETE; the derived accounts view and global worker-owned fx_rates_raw and fx_rates_daily relations are SELECT-only.
kind: 'income' | 'spend' | 'transfer'. category: NULL for transfers.
Budget_lines contains only Base plan rows. Budget adjustments displayed by the app are not exposed to this SQL tool.
All data is workspace-scoped via RLS. INSERTs must include workspace_id.
Only the listed tables and views are allowed. Internal relations are blocked.
Restricted SQL does not support ON CONFLICT. Read first, then use explicit INSERT or UPDATE as separate steps.
Restricted SQL supports only these function calls: SUM, COUNT, MIN, MAX, AVG, and COALESCE. All other functions are blocked. Use ILIKE instead of LOWER(...) for case-insensitive text search, and use explicit date ranges instead of NOW() or DATE_TRUNC().
Use regular single-quoted SQL literals. Dollar-quoted strings are not supported.
For long mutating INSERT or UPDATE scripts, first test the same SQL shape on a tiny representative probe: 1-3 literal rows for INSERT or 1 targeted row for UPDATE. If that probe fails, fix it before continuing. A user's explicit approval for the described change covers the full approved change set, including that probe and all remaining sequential batches. If the probe succeeds, immediately continue with the remaining approved data in sequential batches of at most 100 records per tool call. Do not pause only to ask the user to continue, proceed, or reconfirm for later batches. Only ask again if the requested change itself changes, new ambiguity appears, or execution fails.
For any long mutating script or import, keep explicit completed and pending checkpoints in your replies. Internally track source row ranges when available; otherwise use stable source markers such as timestamps, external IDs, or ordered source chunks. In user-facing progress updates, identify checkpoints with batch counts and human-readable boundaries such as dates, descriptions, and amounts instead of raw row numbers or internal IDs. After each successful batch, record the completed checkpoint and the next pending checkpoint. After a later "continue" message, resume from the last completed checkpoint in the same chat session instead of regenerating earlier batches.
The final stage of any long import is checksum verification. After the last write batch, run fresh reads to verify how many rows were added and what balances now result for the affected account(s). If a resulting balance is negative or this looks like the first import for a specific account, it may be worth clarifying the real current balance with the user and suggesting a backdated adjustment entry if that would reconcile the balance to reality. If the checksum does not match, investigate and prefer targeted cleanup of the inconsistent rows. Ask the user before broad, destructive, or ambiguous cleanup.
If the user has already approved the described import and delegated reasonable assumptions or best-guess defaults, that approval also covers unresolved account naming, category naming, and heuristic mapping choices for that import. After a successful probe, continue with later batches automatically instead of pausing for a cleaner plan or renewed approval.
The result is returned as JSON in the shape { "ok": boolean, "tool": "query_database", "sql": string | null, "statements"?: [ ... ], "error"?: { "name": string, "message": string } }. Each statement keeps rowCount and also includes returnedRowCount, totalRowCount, and truncated so capped SELECT results are visible.`;

const toChatSqlError = (error: SqlPolicyError): Error => {
  if (error.code === "unsupported_statement") {
    return new Error(error.message);
  }
  if (error.code === "on_conflict_not_allowed") {
    return new Error("ON CONFLICT is not supported in chat queries");
  }
  if (error.code === "set_config_not_allowed") {
    return new Error("set_config() calls are not allowed");
  }
  if (error.code === "function_calls_not_allowed") {
    return new Error(error.message);
  }
  if (error.code === "sql_comments_not_allowed") {
    return new Error("SQL comments are not allowed in chat queries");
  }
  if (error.code === "quoted_identifiers_not_allowed") {
    return new Error("Quoted identifiers are not allowed in chat queries");
  }
  if (error.code === "dollar_quoted_strings_not_allowed") {
    return new Error("Dollar-quoted strings are not allowed in chat queries");
  }
  if (error.code === "escape_string_literals_not_allowed") {
    return new Error("PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.");
  }
  if (error.code === "unterminated_string_literal") {
    return new Error("Unterminated SQL string literal");
  }
  if (error.code === "invalid_relation_reference") {
    return new Error("Expected relation name after SQL clause");
  }
  if (error.code === "relation_not_allowed") {
    return new Error(`${error.message} in chat queries`);
  }
  if (error.code === "recursive_cte_search_cycle_not_allowed") {
    return new Error("Recursive CTE SEARCH and CYCLE clauses are not supported in chat queries. Rewrite the CTE without those clauses");
  }
  if (error.code === "read_only_relation_mutation_not_allowed") {
    return new Error(`${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata`);
  }
  return new Error(error.message);
};

export type QueryResult = Readonly<{
  json: string;
}>;

export type ChatSqlExecutionContext = Readonly<{
  userId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
}>;

type UserContextRunner = <T>(
  userId: string,
  workspaceId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
) => Promise<T>;

type RestrictedUserContextRunner = <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
) => Promise<T>;

export type ExecQueryDependencies = Readonly<{
  withUserContext: UserContextRunner;
  withRestrictedUserContext: RestrictedUserContextRunner;
  lockUncancelledChatTurnForMutationWithQuery: typeof lockUncancelledChatTurnForMutationWithQuery;
}>;

const DEFAULT_EXEC_QUERY_DEPENDENCIES: ExecQueryDependencies = {
  withUserContext,
  withRestrictedUserContext,
  lockUncancelledChatTurnForMutationWithQuery,
};

type ChatSqlStatementResult = Readonly<{
  sql: string;
  command: string;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  referencedRelations: ValidatedExpenseSqlStatement["referencedRelations"];
}>;

// The statements payload of this call, which the tool layer parses back out.
const serializeChatSqlStatements = (
  statements: ReadonlyArray<ChatSqlStatementResult>,
): string => JSON.stringify({ statements });

// The exact success output apps/web/src/server/chat/openai/tooling/tools.ts
// emits for this tool call. The script is echoed once around the statements
// array as well as once inside every statement, so the character budget is
// measured on this envelope rather than on the statements alone: the whole
// envelope is what every later model call of the same turn re-sends.
const serializeChatSqlToolOutput = (
  sql: string,
  statements: ReadonlyArray<ChatSqlStatementResult>,
): string => JSON.stringify({
  ok: true,
  tool: CHAT_SQL_TOOL_NAME,
  sql,
  statements,
});

// One budgeted result serves every consumer of this call: what the model reads
// now, what later model calls of the same turn re-send, the stored replay
// history, and the tool-output block the chat transcript renders. All of them
// show the same kept rows and the same truncated flag.
const executeValidatedChatSql = async (
  queryFn: QueryFn,
  sql: string,
  statements: ReadonlyArray<ValidatedExpenseSqlStatement>,
): Promise<ReadonlyArray<ChatSqlStatementResult>> => {
  const results: Array<BudgetedSqlStatementEntry<ChatSqlStatementResult>> = [];
  for (const statement of statements) {
    const result = await queryFn(statement.sql, []);
    const rows = result.rows.slice(0, MAX_ROWS);
    results.push({
      statement: {
        sql: statement.sql,
        command: result.command,
        rows,
        rowCount: rows.length > 0 ? rows.length : (result.rowCount ?? 0),
        returnedRowCount: rows.length,
        totalRowCount: result.rows.length > 0 ? result.rows.length : (result.rowCount ?? 0),
        truncated: result.rows.length > rows.length,
        referencedRelations: statement.referencedRelations,
      },
      isMutating: statement.isMutating,
    });
  }

  return applySqlResultCharBudget(
    results,
    (candidate) => serializeChatSqlToolOutput(sql, candidate).length,
  );
};

export const execQueryWithDependencies = async (
  sql: string,
  context: ChatSqlExecutionContext,
  dependencies: ExecQueryDependencies,
): Promise<QueryResult> => {
  let validated;
  try {
    validated = validateExpenseSql(sql);
  } catch (error) {
    if (error instanceof SqlPolicyError) {
      throw toChatSqlError(error);
    }
    throw error;
  }

  const isMutating = validated.statements.some((statement) => statement.isMutating);
  const statements = isMutating
    ? await dependencies.withUserContext(
      context.userId,
      context.workspaceId,
      async (queryFn) => {
        await queryFn("SELECT set_config('statement_timeout', $1, true)", [
          String(STATEMENT_TIMEOUT_MS),
        ]);
        await dependencies.lockUncancelledChatTurnForMutationWithQuery(
          queryFn,
          context.sessionId,
          context.turnId,
        );
        await queryFn("SET LOCAL ROLE api_sql_executor", []);
        return executeValidatedChatSql(queryFn, sql, validated.statements);
      },
    )
    : await dependencies.withRestrictedUserContext(
      context.userId,
      context.workspaceId,
      STATEMENT_TIMEOUT_MS,
      async (queryFn) => executeValidatedChatSql(queryFn, sql, validated.statements),
    );

  return { json: serializeChatSqlStatements(statements) };
};

export const execQuery = async (
  sql: string,
  context: ChatSqlExecutionContext,
): Promise<QueryResult> =>
  execQueryWithDependencies(sql, context, DEFAULT_EXEC_QUERY_DEPENDENCIES);

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
    } else if (p.type === "pdf") {
      parts.push(`[attached PDF: ${p.fileName}]`);
    }
  }
  return parts.join("\n");
};
