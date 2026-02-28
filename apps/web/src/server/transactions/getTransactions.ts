/**
 * Paginated ledger entry queries for the transactions dashboard.
 *
 * Fetches entries with runtime FX conversion via LATERAL index lookup on
 * exchange_rates (one backward scan per row via idx_exchange_rates_quote_base_date).
 * Supports filtering by date range, account, kind, and category, with
 * configurable sort and pagination. The report-currency amount is computed
 * at read time — no precomputed amount_usd column.
 */
import { withUserContext, queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";

export type LedgerEntry = Readonly<{
  entryId: string;
  eventId: string;
  ts: string;
  accountId: string;
  amount: number;
  amountUsd: number | null;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

export type AccountOption = Readonly<{
  accountId: string;
}>;

export type TransactionsFilter = Readonly<{
  dateFrom: string | null;
  dateTo: string | null;
  accountId: string | null;
  kind: string | null;
  category: string | null;
  categories: ReadonlyArray<string> | null;
  sortKey: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}>;

export type TransactionsPage = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  total: number;
}>;

// PostgreSQL resolves simple names in ORDER BY to output-column aliases, but
// names inside expressions (like ABS(...)) are resolved against input columns
// only. So "ABS(amount_report)" fails because amount_report is a SELECT alias,
// not a real column. We inline the full CASE expression for computed sorts.
// The $1 placeholder is the report currency, same as in the main SELECT.
const AMOUNT_REPORT_EXPR =
  "CASE WHEN le.currency = $1 THEN le.amount::double precision" +
  " WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision" +
  " ELSE NULL END";

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  ts: "ts",
  accountId: "account_id",
  amount: "amount",
  currency: "currency",
  kind: "kind",
  category: "category",
  counterparty: "counterparty",
  amountAbs: "ABS(amount)",
  amountUsdAbs: `ABS(${AMOUNT_REPORT_EXPR})`,
};

const buildWhereClause = (
  filter: TransactionsFilter,
  params: Array<unknown>,
): string => {
  const conditions: Array<string> = [];

  if (filter.dateFrom !== null) {
    params.push(filter.dateFrom + "T00:00:00");
    conditions.push(`le.ts >= $${params.length}`);
  }
  if (filter.dateTo !== null) {
    params.push(filter.dateTo + "T23:59:59.999999");
    conditions.push(`le.ts < $${params.length}`);
  }
  if (filter.accountId !== null) {
    params.push(filter.accountId);
    conditions.push(`le.account_id = $${params.length}`);
  }
  if (filter.kind !== null) {
    params.push(filter.kind);
    conditions.push(`le.kind = $${params.length}`);
  }
  if (filter.category !== null) {
    if (filter.category === "") {
      conditions.push("le.category IS NULL");
    } else {
      params.push(filter.category);
      conditions.push(`le.category = $${params.length}`);
    }
  }
  if (filter.categories !== null) {
    if (filter.categories.length === 0) {
      conditions.push("FALSE");
    } else {
      const hasUncategorized = filter.categories.includes("");
      const named = filter.categories.filter((c) => c !== "");
      const parts: Array<string> = [];
      if (named.length > 0) {
        params.push(named);
        parts.push(`le.category = ANY($${params.length})`);
      }
      if (hasUncategorized) {
        parts.push("le.category IS NULL");
      }
      conditions.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
    }
  }

  if (conditions.length === 0) return "";
  return "WHERE " + conditions.join(" AND ");
};

export const getTransactionsPage = async (
  userId: string,
  workspaceId: string,
  filter: TransactionsFilter,
): Promise<TransactionsPage> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  const sortColumn = SORT_COLUMNS[filter.sortKey];
  if (sortColumn === undefined) {
    throw new Error(`Invalid sortKey: ${filter.sortKey}`);
  }
  const sortDir = filter.sortDir === "asc" ? "ASC" : "DESC";

  const entriesParams: Array<unknown> = [reportCurrency];
  const entriesWhere = buildWhereClause(filter, entriesParams);

  const entriesQuery = `
    SELECT
      le.entry_id, le.event_id, le.ts, le.account_id,
      le.amount::double precision AS amount,
      CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END AS amount_report,
      le.currency, le.kind, le.category, le.counterparty, le.note
    FROM ledger_entries le
    -- LATERAL: one backward index scan per row via idx_exchange_rates_quote_base_date,
    -- replacing the old rate_ranges CTE that materialized the entire exchange_rates
    -- table and did an O(N×M) non-equi range join.
    LEFT JOIN LATERAL (
      SELECT rate FROM exchange_rates
      WHERE quote_currency = $1
        AND base_currency = le.currency
        AND rate_date <= le.ts::date
      ORDER BY rate_date DESC
      LIMIT 1
    ) r ON true
    ${entriesWhere}
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT $${entriesParams.push(filter.limit)}
    OFFSET $${entriesParams.push(filter.offset)}
  `;

  const countParams: Array<unknown> = [];
  const countWhere = buildWhereClause(filter, countParams);

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM ledger_entries le
    ${countWhere}
  `;

  return withUserContext(userId, workspaceId, async (q) => {
    const [entriesResult, countResult] = await Promise.all([
      q(entriesQuery, entriesParams),
      q(countQuery, countParams),
    ]);

    return {
      entries: entriesResult.rows.map((row: {
        entry_id: string;
        event_id: string;
        ts: string;
        account_id: string;
        amount: number;
        amount_report: number | null;
        currency: string;
        kind: string;
        category: string | null;
        counterparty: string | null;
        note: string | null;
      }) => ({
        entryId: row.entry_id,
        eventId: row.event_id,
        ts: new Date(row.ts).toISOString(),
        accountId: row.account_id,
        amount: Number(row.amount),
        amountUsd: row.amount_report !== null ? Number(row.amount_report) : null,
        currency: row.currency,
        kind: row.kind,
        category: row.category,
        counterparty: row.counterparty,
        note: row.note,
      })),
      total: Number((countResult.rows[0] as { total: string }).total),
    };
  });
};

export const getAccounts = async (userId: string, workspaceId: string): Promise<ReadonlyArray<AccountOption>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT DISTINCT account_id FROM ledger_entries ORDER BY account_id",
    [],
  );
  return result.rows.map((row: { account_id: string }) => ({
    accountId: row.account_id,
  }));
};

export const getCategories = async (userId: string, workspaceId: string): Promise<ReadonlyArray<string>> => {
  const result = await queryAs(
    userId,
    workspaceId,
    "SELECT DISTINCT category FROM ledger_entries WHERE category IS NOT NULL ORDER BY category",
    [],
  );
  return result.rows.map((row: { category: string }) => row.category);
};

export type FieldHints = Readonly<{
  accounts: ReadonlyArray<string>;
  currencies: ReadonlyArray<string>;
  counterparties: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
}>;

const HINTS_SQL = (col: string): string =>
  `SELECT DISTINCT ${col} FROM ledger_entries WHERE ts >= NOW() - INTERVAL '60 days' AND ${col} IS NOT NULL ORDER BY ${col}`;

export const getFieldHints = async (userId: string, workspaceId: string): Promise<FieldHints> => {
  const [accounts, currencies, counterparties, notes] = await Promise.all([
    queryAs(userId, workspaceId, HINTS_SQL("account_id"), []),
    queryAs(userId, workspaceId, HINTS_SQL("currency"), []),
    queryAs(userId, workspaceId, HINTS_SQL("counterparty"), []),
    queryAs(userId, workspaceId, HINTS_SQL("note"), []),
  ]);
  return {
    accounts: accounts.rows.map((r: { account_id: string }) => r.account_id),
    currencies: currencies.rows.map((r: { currency: string }) => r.currency),
    counterparties: counterparties.rows.map((r: { counterparty: string }) => r.counterparty),
    notes: notes.rows.map((r: { note: string }) => r.note),
  };
};
