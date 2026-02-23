/**
 * Paginated ledger entry queries for the transactions dashboard.
 *
 * Fetches entries with runtime FX conversion via a LEFT JOIN on exchange_rates
 * using date-range matching (rate valid from rate_date until next_rate_date).
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
  sortKey: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}>;

export type TransactionsPage = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  total: number;
}>;

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  ts: "ts",
  accountId: "account_id",
  amount: "amount",
  currency: "currency",
  kind: "kind",
  category: "category",
  counterparty: "counterparty",
  amountAbs: "ABS(amount)",
  amountUsdAbs: "ABS(amount_report)",
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

  if (conditions.length === 0) return "";
  return "WHERE " + conditions.join(" AND ");
};

export const getTransactionsPage = async (
  userId: string,
  workspaceId: string,
  filter: TransactionsFilter,
): Promise<TransactionsPage> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  const sortColumn = SORT_COLUMNS[filter.sortKey] ?? "ts";
  const sortDir = filter.sortDir === "asc" ? "ASC" : "DESC";

  const entriesParams: Array<unknown> = [reportCurrency];
  const entriesWhere = buildWhereClause(filter, entriesParams);

  const entriesQuery = `
    WITH rate_ranges AS (
      SELECT
        base_currency, rate_date, rate,
        LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
      FROM exchange_rates
      WHERE quote_currency = $1
    )
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
    LEFT JOIN rate_ranges r
      ON r.base_currency = le.currency
      AND le.ts::date >= r.rate_date
      AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
    ${entriesWhere}
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT ${filter.limit}
    OFFSET ${filter.offset}
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
