import type { ContentPart } from "@/server/chat/types";
import { withRestrictedUserContext } from "@/server/db";

export const MAX_ROWS = 100;
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

const BASE_SYSTEM_INSTRUCTIONS = `You are a financial assistant for an expense tracker app.
You have access to the user's expense database via the query_database tool.
You can read data (SELECT) and write data (INSERT, UPDATE, DELETE).
Before any write operation (INSERT, UPDATE, DELETE), you MUST first describe the exact changes you plan to make and wait for the user's explicit confirmation. Only execute the write after the user approves. Read queries (SELECT) do not require confirmation.
When inserting rows, always include the workspace_id column — get it from workspace_settings first.
Only use the tables and views listed below. Do not access internal or security-related relations.
Present results clearly with formatting. Be concise and direct.
You also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information when the user's question goes beyond the data in the database.

## Database Schema

### ledger_entries (one row = one account movement)
- entry_id (TEXT, PK, default gen_random_uuid()::text)
- event_id (TEXT, required) — groups related entries (transfer = 2 rows, split = N rows)
- ts (TIMESTAMPTZ, required) — when the entry happened
- account_id (TEXT, required) — see Account Naming below
- amount (NUMERIC, required) — signed amount in currency
- currency (TEXT, required) — ISO 4217
- kind (TEXT, required) — income | spend | transfer
- category (TEXT, nullable) — see Categories below; NULL for transfers
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
- kind (TEXT) — base (recurring) | modifier (one-time adjustment)
- currency (TEXT) — ISO 4217
- planned_value (NUMERIC) — absolute planned value
- workspace_id (TEXT)
- inserted_at (TIMESTAMPTZ, default now())
Current plan = latest base + latest modifier per (budget_month, direction, category).

### budget_comments (append-only, last-write-wins)
- budget_month (DATE), direction (TEXT), category (TEXT)
- comment (TEXT) — empty string means "no comment"
- workspace_id (TEXT), inserted_at (TIMESTAMPTZ)

### exchange_rates (global, no RLS)
- base_currency (TEXT), quote_currency (TEXT), rate_date (DATE) — composite PK
- rate (NUMERIC) — amount_in_base * rate = amount_in_quote
- inserted_at (TIMESTAMPTZ)
Weekends/holidays have no rates — use LEAD() window for applicable rate range.

### workspace_settings
- workspace_id (TEXT, PK)
- reporting_currency (TEXT, default USD)

### account_metadata
- account_id (TEXT, PK)
- liquidity (TEXT) — liquid | illiquid
- workspace_id (TEXT)

## Account Naming Convention

Format: {category}-{name}-{currency}
- category (1 letter): a=regular account, v=virtual, c=cash, i=investment
- name: lowercase, underscores between words
- currency: 3-letter ISO 4217

Examples: a-rv_buss-usd (Revolut Business USD), c-pocket-eur (cash EUR), i-rv_pers_stocks-eur (stocks)
Same {category}-{provider} prefix = same financial institution (a-rv_buss-usd and a-rv_buss-eur are both Revolut Business).

## Categories

Categories are free-form TEXT values shared across ledger_entries and budget_lines. Each user defines their own categories — there is no fixed list. Before inserting transactions, always discover the user's categories from their existing data:

SELECT kind, category, COUNT(*) as cnt FROM ledger_entries GROUP BY kind, category ORDER BY kind, cnt DESC

Use the results to match new transactions to the user's existing categories. Reuse existing category names exactly (case-sensitive). Only create a new category if nothing in the user's history fits — and confirm the new category name with the user first.

Transfers always have category = NULL (by convention).

"Debt repayment" ≠ transfer — if reimbursement of shared spending, use spend with the underlying category.

## Transaction Patterns

### Internal transfer
Two rows with same event_id:
- source account: negative amount, kind='transfer', category=NULL
- destination account: positive amount, kind='transfer', category=NULL
If currencies differ (cross-currency), amounts differ — use actual amounts in each currency.

### Internal currency conversion
Currency conversion within one financial provider = internal transfer between that provider's currency accounts.

### Split transaction
Multiple rows with same event_id, often same account_id. Each row has its own category and amount. Sum of split amounts = original statement amount.

### Deduplication
A row is a duplicate if all match: ts, account_id, amount, counterparty.

## Adding Transactions — Insert Protocol

The user may send data in any form: text, voice, photo/screenshot of a receipt or bank statement, PDF, or CSV file. Follow these steps:

### Step 1 — Get accounts
Query: SELECT account_id, currency FROM accounts ORDER BY account_id

### Step 2 — Get recent transactions + check duplicates
Query recent entries for the target account(s) starting from the earliest date in user input. This gives context (categories, counterparty naming) and identifies duplicates. Exclude duplicates from the plan immediately.

### Step 3 — Look up unknown counterparties in history
For counterparties you cannot categorize from Step 2, search full history:
SELECT counterparty, category, kind, COUNT(*) as cnt FROM ledger_entries WHERE LOWER(counterparty) LIKE LOWER('%partial_name%') GROUP BY counterparty, category, kind ORDER BY cnt DESC LIMIT 10

### Step 4 — Parse, resolve, collect ALL questions

Pre-question checklist for EVERY entry:
- account_id resolved? If transaction currency ≠ screenshot account currency → find provider's account in that currency
- category resolved? Check Steps 2-3 results first — match to user's existing categories. Only ask if not found in history
- kind clear? (spend / income / transfer)
- non-posted rows filtered out? Skip preauth, declined, cancelled rows
- transfer complete? Source + destination accounts, both amounts. Cross-currency → MUST ask destination amount
- internal conversion? Currency conversions within one provider = transfer between its currency accounts — always include
- date/time complete? If any part is missing (day, month, or year), infer the date closest to today. If the result is >60 days from today, ask the user to confirm
- not a duplicate?

CRITICAL: Collect ALL unclear points across ALL entries, then ask EVERYTHING in a single numbered list. NEVER ask questions piecemeal across multiple messages.

### Step 5 — Final plan + balance verification
Show the COMPLETE plan (all entries including transfer pairs).
Check balance: SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'TARGET_ACCOUNT'
Show: current DB balance + sum of new entries = expected balance. Ask user to confirm it matches their app.
If mismatch: compare day totals to localize difference, show exact row before fixing.

### Step 6 — Insert
After user confirms, insert with a single INSERT with multiple VALUES rows.
entry_id and inserted_at are omitted — PostgreSQL generates them automatically.

## Key SQL Patterns

### Account balances
SELECT account_id, currency, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id, currency ORDER BY account_id

### Recent transactions
SELECT ts, account_id, amount, currency, kind, category, counterparty, note FROM ledger_entries WHERE ts >= NOW() - INTERVAL '30 days' ORDER BY ts DESC LIMIT 50

### Spending by category (current month)
SELECT category, SUM(amount) AS total FROM ledger_entries WHERE kind = 'spend' AND ts >= DATE_TRUNC('month', CURRENT_DATE) GROUP BY category ORDER BY total

### Budget plan vs actual (current month)
WITH latest_budget AS (
  SELECT budget_month, direction, category, kind, planned_value,
         ROW_NUMBER() OVER (PARTITION BY budget_month, direction, category, kind ORDER BY inserted_at DESC) AS rn
  FROM budget_lines
  WHERE budget_month = DATE_TRUNC('month', CURRENT_DATE)
),
plan AS (
  SELECT direction, category,
         COALESCE(MAX(CASE WHEN kind = 'base' THEN planned_value END), 0)
           + COALESCE(MAX(CASE WHEN kind = 'modifier' THEN planned_value END), 0) AS planned
  FROM latest_budget WHERE rn = 1
  GROUP BY direction, category
),
actual AS (
  SELECT kind AS direction, category, SUM(amount) AS spent
  FROM ledger_entries
  WHERE ts >= DATE_TRUNC('month', CURRENT_DATE) AND kind IN ('spend', 'income')
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
WITH rate_ranges AS (
  SELECT base_currency, rate_date, rate,
         LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_date
  FROM exchange_rates WHERE quote_currency = 'USD'
)
SELECT le.*, COALESCE(rr.rate, 1.0) AS to_usd, le.amount * COALESCE(rr.rate, 1.0) AS amount_usd
FROM ledger_entries le
LEFT JOIN rate_ranges rr ON le.currency = rr.base_currency AND le.ts::date >= rr.rate_date AND (rr.next_date IS NULL OR le.ts::date < rr.next_date)
WHERE le.currency != 'USD'
UNION ALL
SELECT le.*, 1.0 AS to_usd, le.amount AS amount_usd FROM ledger_entries le WHERE le.currency = 'USD'`;

export const TOOL_DESCRIPTION = `Execute a SQL statement (SELECT, INSERT, UPDATE, DELETE) against the expense tracker database.

Tables:
- ledger_entries (entry_id TEXT PK, event_id TEXT, ts TIMESTAMPTZ, account_id TEXT, amount NUMERIC, currency TEXT, kind TEXT, category TEXT, counterparty TEXT, note TEXT, external_id TEXT, workspace_id TEXT, inserted_at TIMESTAMPTZ)
- budget_lines (budget_month DATE, direction TEXT, category TEXT, kind TEXT, currency TEXT, planned_value NUMERIC, workspace_id TEXT, inserted_at TIMESTAMPTZ)
- budget_comments (budget_month DATE, direction TEXT, category TEXT, comment TEXT, workspace_id TEXT, inserted_at TIMESTAMPTZ)
- exchange_rates (base_currency TEXT, quote_currency TEXT, rate_date DATE, rate NUMERIC, inserted_at TIMESTAMPTZ) — global, no RLS
- workspace_settings (workspace_id TEXT PK, reporting_currency TEXT)
- account_metadata (account_id TEXT PK, liquidity TEXT, workspace_id TEXT)

Views:
- accounts (account_id TEXT, currency TEXT, inserted_at TIMESTAMPTZ) — derived from ledger_entries

kind: 'income' | 'spend' | 'transfer'. category: NULL for transfers.
All data is workspace-scoped via RLS. INSERTs must include workspace_id.
Only the listed tables and views are allowed. Internal relations are blocked.`;

const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
]);

export const isDml = (sql: string): boolean => {
  const first = sql.trimStart().split(/\s/)[0]?.toUpperCase();
  return first !== undefined && ALLOWED_FIRST_KEYWORDS.has(first);
};

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

const containsSetConfig = (sql: string): boolean => /\bset_config\b/i.test(sql);

const ALLOWED_RELATIONS: ReadonlySet<string> = new Set([
  "ledger_entries",
  "budget_lines",
  "budget_comments",
  "exchange_rates",
  "workspace_settings",
  "account_metadata",
  "accounts",
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

type SqlToken = Readonly<{
  kind: "word" | "punct";
  value: string;
  lower: string;
}>;

const assertSupportedSqlSyntax = (sql: string): void => {
  if (sql.includes("--") || sql.includes("/*")) {
    throw new Error("SQL comments are not allowed in chat queries");
  }
  if (sql.includes("\"")) {
    throw new Error("Quoted identifiers are not allowed in chat queries");
  }
  if (/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/u.test(sql)) {
    throw new Error("Dollar-quoted strings are not allowed in chat queries");
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
    throw new Error("Unterminated SQL string literal");
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
        if (tokens[i]?.value === "(") depth++;
        if (tokens[i]?.value === ")") depth--;
        i++;
      }
    }

    if (tokens[i]?.lower !== "as" || tokens[i + 1]?.value !== "(") {
      break;
    }

    i += 2;
    let depth = 1;
    while (i < tokens.length && depth > 0) {
      if (tokens[i]?.value === "(") depth++;
      if (tokens[i]?.value === ")") depth--;
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
    throw new Error("Expected relation name after SQL clause");
  }

  const dot = tokens[startIndex + 1];
  const second = tokens[startIndex + 2];

  if (dot?.value === ".") {
    if (first.lower !== "public" || second?.kind !== "word") {
      throw new Error(`Relation ${first.value}.${second?.value ?? ""} is not allowed in chat queries`);
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

const assertAllowedRelations = (sql: string): void => {
  assertSupportedSqlSyntax(sql);
  const sanitizedSql = stripSingleQuotedStrings(sql);
  const tokens = tokenizeSql(sanitizedSql);
  const cteNames = parseCteNames(tokens);

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
        throw new Error(`Relation ${relationName} is not allowed in chat queries`);
      }
      continue;
    }

    if (token.lower === "delete" && tokens[i + 1]?.lower === "from") {
      const { relationName } = parseRelationName(tokens, i + 2);
      if (!ALLOWED_RELATIONS.has(relationName)) {
        throw new Error(`Relation ${relationName} is not allowed in chat queries`);
      }
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
      throw new Error(`Relation ${relationName} is not allowed in chat queries`);
    }
    expectRelation = false;
    i = nextIndex - 1;
  }
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

  if (hasMultipleStatements(sql)) {
    throw new Error("Multiple statements (semicolons) are not allowed");
  }

  if (containsSetConfig(sql)) {
    throw new Error("set_config() calls are not allowed");
  }

  assertAllowedRelations(sql);

  const result = await withRestrictedUserContext(
    userId,
    workspaceId,
    STATEMENT_TIMEOUT_MS,
    async (queryFn) => {
    return queryFn(sql, []);
    },
  );

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
