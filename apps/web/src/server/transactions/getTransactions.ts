/**
 * Paginated ledger entry queries for the transactions dashboard.
 *
 * Reads query-ready daily FX pairs from fx_rates_daily.
 *
 * The worker expands raw market data into exact-date all-pairs rates ahead of
 * time, so this query only has to do a single equality join per ledger row.
 */
import { withUserContext, queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";

export type LedgerEntry = Readonly<{
  entryId: string;
  eventId: string;
  ts: string;
  accountId: string;
  amount: number;
  amountReport: number | null;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

export type LedgerEntryRow = Readonly<{
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
}>;

export const mapLedgerEntryRow = (row: LedgerEntryRow): LedgerEntry => ({
  entryId: row.entry_id,
  eventId: row.event_id,
  ts: new Date(row.ts).toISOString(),
  accountId: row.account_id,
  amount: Number(row.amount),
  amountReport: row.amount_report !== null ? Number(row.amount_report) : null,
  currency: row.currency,
  kind: row.kind,
  category: row.category,
  counterparty: row.counterparty,
  note: row.note,
});

export type AccountOption = Readonly<{
  accountId: string;
}>;

export const TRANSACTION_KINDS = ["income", "spend", "transfer"] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export type TransactionsFilter = Readonly<{
  dateFrom: string | null;
  dateTo: string | null;
  accountId: string | null;
  accountIds: ReadonlyArray<string> | null;
  kind: string | null;
  kinds: ReadonlyArray<string> | null;
  currencies: ReadonlyArray<string> | null;
  category: string | null;
  categories: ReadonlyArray<string> | null;
  counterparties: ReadonlyArray<string> | null;
  businessPersonalTransfers: boolean;
  sortKey: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}>;

export type TransactionsPage = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  total: number;
}>;

export type TransactionsFilterOptions = Readonly<{
  accounts: ReadonlyArray<string>;
  categories: ReadonlyArray<string>;
  currencies: ReadonlyArray<string>;
  counterparties: ReadonlyArray<string>;
  kinds: ReadonlyArray<TransactionKind>;
}>;

// PostgreSQL resolves simple names in ORDER BY to output-column aliases, but
// names inside expressions (like ABS(...)) are resolved against input columns
// only. So "ABS(amount_report)" fails because amount_report is a SELECT alias,
// not a real column. We inline the full CASE expression for computed sorts.
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
  amountReportAbs: `ABS(${AMOUNT_REPORT_EXPR})`,
};

const appendAnyTextCondition = (
  column: string,
  values: ReadonlyArray<string>,
  params: Array<unknown>,
  conditions: Array<string>,
): void => {
  if (values.length === 0) {
    conditions.push("FALSE");
    return;
  }

  params.push(values);
  conditions.push(`${column} = ANY($${params.length})`);
};

const appendNullableAnyTextCondition = (
  column: string,
  values: ReadonlyArray<string>,
  params: Array<unknown>,
  conditions: Array<string>,
): void => {
  if (values.length === 0) {
    conditions.push("FALSE");
    return;
  }

  const hasEmptyValue = values.includes("");
  const namedValues = values.filter((value) => value !== "");
  const parts: Array<string> = [];

  if (namedValues.length > 0) {
    params.push(namedValues);
    parts.push(`${column} = ANY($${params.length})`);
  }
  if (hasEmptyValue) {
    parts.push(`${column} IS NULL`);
  }

  conditions.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
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
  if (filter.accountIds !== null) {
    appendAnyTextCondition("le.account_id", filter.accountIds, params, conditions);
  }
  if (filter.kind !== null) {
    params.push(filter.kind);
    conditions.push(`le.kind = $${params.length}`);
  }
  if (filter.kinds !== null) {
    appendAnyTextCondition("le.kind", filter.kinds, params, conditions);
  }
  if (filter.currencies !== null) {
    appendAnyTextCondition("le.currency", filter.currencies, params, conditions);
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
    appendNullableAnyTextCondition("le.category", filter.categories, params, conditions);
  }
  if (filter.counterparties !== null) {
    appendNullableAnyTextCondition("le.counterparty", filter.counterparties, params, conditions);
  }
  if (filter.businessPersonalTransfers) {
    conditions.push(`
      le.kind = 'transfer'
      AND EXISTS (
        SELECT 1
        FROM ledger_entries business_le
        LEFT JOIN account_metadata business_am
          ON business_am.account_id = business_le.account_id
         AND business_am.workspace_id = business_le.workspace_id
        WHERE business_le.workspace_id = le.workspace_id
          AND business_le.event_id = le.event_id
          AND business_le.kind = 'transfer'
          AND COALESCE(business_am.account_type, 'personal') = 'business'
      )
      AND EXISTS (
        SELECT 1
        FROM ledger_entries personal_le
        LEFT JOIN account_metadata personal_am
          ON personal_am.account_id = personal_le.account_id
         AND personal_am.workspace_id = personal_le.workspace_id
        WHERE personal_le.workspace_id = le.workspace_id
          AND personal_le.event_id = le.event_id
          AND personal_le.kind = 'transfer'
          AND COALESCE(personal_am.account_type, 'personal') = 'personal'
      )
    `);
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
    LEFT JOIN fx_rates_daily r
      ON r.quote_currency = $1
      AND r.base_currency = le.currency
      AND r.calendar_date = le.ts::date
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
      entries: entriesResult.rows.map((row: LedgerEntryRow): LedgerEntry => mapLedgerEntryRow(row)),
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

export const getTransactionsFilterOptions = async (
  userId: string,
  workspaceId: string,
): Promise<TransactionsFilterOptions> => {
  const [accounts, categories, currencies, counterparties] = await Promise.all([
    queryAs(userId, workspaceId, "SELECT DISTINCT account_id FROM ledger_entries ORDER BY account_id", []),
    queryAs(userId, workspaceId, "SELECT DISTINCT category FROM ledger_entries WHERE category IS NOT NULL ORDER BY category", []),
    queryAs(userId, workspaceId, "SELECT DISTINCT currency FROM ledger_entries ORDER BY currency", []),
    queryAs(userId, workspaceId, "SELECT DISTINCT counterparty FROM ledger_entries WHERE counterparty IS NOT NULL ORDER BY counterparty", []),
  ]);

  return {
    accounts: accounts.rows.map((row: { account_id: string }) => row.account_id),
    categories: categories.rows.map((row: { category: string }) => row.category),
    currencies: currencies.rows.map((row: { currency: string }) => row.currency),
    counterparties: counterparties.rows.map((row: { counterparty: string }) => row.counterparty),
    kinds: [...TRANSACTION_KINDS],
  };
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
