/**
 * Static demo data for demo mode. All values are pre-computed from the
 * equivalent of db/seeds/demo.sql. No database access.
 *
 * Each exported function matches the return type of its real server counterpart.
 */
import type { AccountRow, BalancesSummaryResult, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import type { BudgetGridResult, BudgetRow, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import type { CommentedCell } from "@/server/budget/getCommentedCells";
import type { FxBreakdownResult, FxBreakdownRow } from "@/server/budget/getFxBreakdown";
import type { AccountOption, LedgerEntry, TransactionsFilter, TransactionsPage } from "@/server/transactions/getTransactions";
import { generateMonthRange } from "@/lib/monthUtils";

// ---------------------------------------------------------------------------
// Raw demo entries (sorted by ts DESC — default for transactions)
// ---------------------------------------------------------------------------

const DEMO_ENTRIES: ReadonlyArray<LedgerEntry> = [
  { entryId: "e016", eventId: "ev016", ts: "2026-02-12T09:30:00.000Z", accountId: "checking-usd", amount: -200, amountUsd: -200, currency: "USD", kind: "spend", category: "utilities", counterparty: "Electric Co", note: "Feb electricity" },
  { entryId: "e015", eventId: "ev015", ts: "2026-02-10T16:45:00.000Z", accountId: "checking-gbp", amount: -30, amountUsd: -37.2, currency: "GBP", kind: "spend", category: "subscriptions", counterparty: "Streaming Co", note: "Monthly plan" },
  { entryId: "e022", eventId: "ev022", ts: "2026-02-08T08:00:00.000Z", accountId: "checking-usd", amount: -500, amountUsd: -500, currency: "USD", kind: "transfer", category: null, counterparty: null, note: "To GBP account" },
  { entryId: "e023", eventId: "ev022", ts: "2026-02-08T08:00:00.000Z", accountId: "checking-gbp", amount: 400, amountUsd: 496, currency: "GBP", kind: "transfer", category: null, counterparty: null, note: "From USD account" },
  { entryId: "e002", eventId: "ev002", ts: "2026-02-05T09:00:00.000Z", accountId: "checking-usd", amount: 5000, amountUsd: 5000, currency: "USD", kind: "income", category: "salary", counterparty: "Employer Inc", note: "Feb salary" },
  { entryId: "e014", eventId: "ev014", ts: "2026-02-01T11:00:00.000Z", accountId: "checking-usd", amount: -1500, amountUsd: -1500, currency: "USD", kind: "spend", category: "rent", counterparty: "Landlord LLC", note: "Feb rent" },
  { entryId: "e013", eventId: "ev013", ts: "2026-01-22T20:00:00.000Z", accountId: "checking-usd", amount: -85, amountUsd: -85, currency: "USD", kind: "spend", category: "dining", counterparty: "Restaurant", note: "Dinner" },
  { entryId: "e003", eventId: "ev003", ts: "2026-01-20T12:00:00.000Z", accountId: "checking-eur", amount: 800, amountUsd: 823.2, currency: "EUR", kind: "income", category: "freelance", counterparty: "Client GmbH", note: "Consulting" },
  { entryId: "e012", eventId: "ev012", ts: "2026-01-15T14:20:00.000Z", accountId: "checking-eur", amount: -45, amountUsd: -46.31, currency: "EUR", kind: "spend", category: "transport", counterparty: "Deutsche Bahn", note: "Train ticket" },
  { entryId: "e011", eventId: "ev011", ts: "2026-01-12T10:00:00.000Z", accountId: "checking-usd", amount: -1500, amountUsd: -1500, currency: "USD", kind: "spend", category: "rent", counterparty: "Landlord LLC", note: "Jan rent" },
  { entryId: "e020", eventId: "ev020", ts: "2026-01-10T08:00:00.000Z", accountId: "checking-usd", amount: -2000, amountUsd: -2000, currency: "USD", kind: "transfer", category: null, counterparty: null, note: "To savings" },
  { entryId: "e021", eventId: "ev020", ts: "2026-01-10T08:00:00.000Z", accountId: "savings-usd", amount: 2000, amountUsd: 2000, currency: "USD", kind: "transfer", category: null, counterparty: null, note: "From checking" },
  { entryId: "e010", eventId: "ev010", ts: "2026-01-08T18:30:00.000Z", accountId: "checking-usd", amount: -120.5, amountUsd: -120.5, currency: "USD", kind: "spend", category: "groceries", counterparty: "Whole Foods", note: null },
  { entryId: "e001", eventId: "ev001", ts: "2026-01-05T09:00:00.000Z", accountId: "checking-usd", amount: 5000, amountUsd: 5000, currency: "USD", kind: "income", category: "salary", counterparty: "Employer Inc", note: "Jan salary" },
];

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

const DEMO_ACCOUNTS: ReadonlyArray<AccountRow> = [
  { accountId: "checking-eur", currency: "EUR", status: "active", balance: 755, balanceUsd: 786.71, lastTransactionTs: "2026-01-20T12:00:00.000Z", overdue: false },
  { accountId: "checking-gbp", currency: "GBP", status: "active", balance: 370, balanceUsd: 464.35, lastTransactionTs: "2026-02-10T16:45:00.000Z", overdue: false },
  { accountId: "checking-usd", currency: "USD", status: "active", balance: 4094.5, balanceUsd: 4094.5, lastTransactionTs: "2026-02-12T09:30:00.000Z", overdue: false },
  { accountId: "savings-usd", currency: "USD", status: "active", balance: 2000, balanceUsd: 2000, lastTransactionTs: null, overdue: false },
];

const DEMO_TOTALS: ReadonlyArray<CurrencyTotal> = [
  { currency: "EUR", balance: 755, balancePositive: 755, balanceNegative: 0, balanceUsd: 786.71, hasUnconvertible: false },
  { currency: "GBP", balance: 370, balancePositive: 370, balanceNegative: 0, balanceUsd: 464.35, hasUnconvertible: false },
  { currency: "USD", balance: 6094.5, balancePositive: 6094.5, balanceNegative: 0, balanceUsd: 6094.5, hasUnconvertible: false },
];

const DEMO_CONVERSION_WARNINGS: ReadonlyArray<ConversionWarning> = [];

export const getDemoBalancesSummary = (): BalancesSummaryResult => ({
  accounts: DEMO_ACCOUNTS,
  totals: DEMO_TOTALS,
  conversionWarnings: DEMO_CONVERSION_WARNINGS,
});

// ---------------------------------------------------------------------------
// Transactions (with client-side filter/sort/paginate)
// ---------------------------------------------------------------------------

const SORT_ACCESSORS: Readonly<Record<string, (e: LedgerEntry) => string | number>> = {
  ts: (e) => e.ts,
  accountId: (e) => e.accountId,
  amount: (e) => e.amount,
  amountAbs: (e) => Math.abs(e.amount),
  amountUsdAbs: (e) => Math.abs(e.amountUsd ?? 0),
  currency: (e) => e.currency,
  kind: (e) => e.kind,
  category: (e) => e.category ?? "",
  counterparty: (e) => e.counterparty ?? "",
};

const applyFilter = (entries: ReadonlyArray<LedgerEntry>, filter: TransactionsFilter): ReadonlyArray<LedgerEntry> => {
  let result = entries;
  if (filter.dateFrom !== null) {
    const from = filter.dateFrom + "T00:00:00";
    result = result.filter((e) => e.ts >= from);
  }
  if (filter.dateTo !== null) {
    const to = filter.dateTo + "T23:59:59.999999";
    result = result.filter((e) => e.ts < to);
  }
  if (filter.accountId !== null) {
    result = result.filter((e) => e.accountId === filter.accountId);
  }
  if (filter.kind !== null) {
    result = result.filter((e) => e.kind === filter.kind);
  }
  if (filter.category !== null) {
    if (filter.category === "") {
      result = result.filter((e) => e.category === null);
    } else {
      result = result.filter((e) => e.category === filter.category);
    }
  }
  return result;
};

const applySort = (entries: ReadonlyArray<LedgerEntry>, sortKey: string, sortDir: "asc" | "desc"): ReadonlyArray<LedgerEntry> => {
  const accessor = SORT_ACCESSORS[sortKey] ?? SORT_ACCESSORS["ts"];
  const sorted = [...entries].sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return 0;
  });
  return sortDir === "desc" ? sorted.reverse() : sorted;
};

export const getDemoTransactionsPage = (filter: TransactionsFilter): TransactionsPage => {
  const filtered = applyFilter(DEMO_ENTRIES, filter);
  const sorted = applySort(filtered, filter.sortKey, filter.sortDir);
  const page = sorted.slice(filter.offset, filter.offset + filter.limit);
  return { entries: page, total: filtered.length };
};

export const getDemoAccounts = (): ReadonlyArray<AccountOption> => [
  { accountId: "checking-eur" },
  { accountId: "checking-gbp" },
  { accountId: "checking-usd" },
  { accountId: "savings-usd" },
];

// ---------------------------------------------------------------------------
// Budget grid
// ---------------------------------------------------------------------------

const DEMO_BUDGET_ROWS: ReadonlyArray<BudgetRow> = [
  // Jan 2026
  { month: "2026-01", direction: "income", category: "freelance", plannedBase: 500, plannedModifier: 0, planned: 500, actual: 823.2, hasUnconvertible: false },
  { month: "2026-01", direction: "income", category: "salary", plannedBase: 5000, plannedModifier: 0, planned: 5000, actual: 5000, hasUnconvertible: false },
  { month: "2026-01", direction: "spend", category: "dining", plannedBase: 200, plannedModifier: 0, planned: 200, actual: 85, hasUnconvertible: false },
  { month: "2026-01", direction: "spend", category: "groceries", plannedBase: 400, plannedModifier: -100, planned: 300, actual: 120.5, hasUnconvertible: false },
  { month: "2026-01", direction: "spend", category: "rent", plannedBase: 1500, plannedModifier: 0, planned: 1500, actual: 1500, hasUnconvertible: false },
  { month: "2026-01", direction: "spend", category: "transport", plannedBase: 100, plannedModifier: 0, planned: 100, actual: 46.31, hasUnconvertible: false },
  { month: "2026-01", direction: "transfer", category: "", plannedBase: 0, plannedModifier: 0, planned: 0, actual: 0, hasUnconvertible: false },
  // Feb 2026
  { month: "2026-02", direction: "income", category: "salary", plannedBase: 5000, plannedModifier: 0, planned: 5000, actual: 5000, hasUnconvertible: false },
  { month: "2026-02", direction: "spend", category: "groceries", plannedBase: 400, plannedModifier: 0, planned: 400, actual: 0, hasUnconvertible: false },
  { month: "2026-02", direction: "spend", category: "rent", plannedBase: 1500, plannedModifier: 0, planned: 1500, actual: 1500, hasUnconvertible: false },
  { month: "2026-02", direction: "spend", category: "subscriptions", plannedBase: 50, plannedModifier: 0, planned: 50, actual: 37.2, hasUnconvertible: false },
  { month: "2026-02", direction: "spend", category: "utilities", plannedBase: 250, plannedModifier: 0, planned: 250, actual: 200, hasUnconvertible: false },
  { month: "2026-02", direction: "transfer", category: "", plannedBase: 0, plannedModifier: 0, planned: 0, actual: -4, hasUnconvertible: false },
];

const DEMO_CUMULATIVE_BEFORE: CumulativeBefore = {
  incomeActual: 0,
  spendActual: 0,
  transferActual: 0,
};

const DEMO_MONTH_END_BALANCES: Readonly<Record<string, number>> = {
  "2025-12": 0,
  "2026-01": 5071.39,
  "2026-02": 7345.56,
};

export const getDemoBudgetGrid = (
  monthFrom: string,
  monthTo: string,
  _planFrom: string,
  _actualTo: string,
): BudgetGridResult => {
  const months = new Set(generateMonthRange(monthFrom, monthTo));
  const rows = DEMO_BUDGET_ROWS.filter((r) => months.has(r.month));
  return {
    rows,
    conversionWarnings: [],
    cumulativeBefore: DEMO_CUMULATIVE_BEFORE,
    monthEndBalances: DEMO_MONTH_END_BALANCES,
  };
};

// ---------------------------------------------------------------------------
// Budget comments
// ---------------------------------------------------------------------------

type CommentEntry = Readonly<{
  month: string;
  direction: string;
  category: string;
  comment: string;
}>;

const DEMO_COMMENTS: ReadonlyArray<CommentEntry> = [
  { month: "2026-01", direction: "spend", category: "groceries", comment: "Reduced budget due to travel" },
  { month: "2026-02", direction: "spend", category: "utilities", comment: "Expected higher bill this month" },
];

export const getDemoLatestComment = (params: Readonly<{ month: string; direction: string; category: string }>): string | null => {
  const match = DEMO_COMMENTS.find(
    (c) => c.month === params.month && c.direction === params.direction && c.category === params.category,
  );
  return match?.comment ?? null;
};

export const getDemoCommentedCells = (params: Readonly<{ monthFrom: string; monthTo: string }>): ReadonlyArray<CommentedCell> =>
  DEMO_COMMENTS
    .filter((c) => c.month >= params.monthFrom && c.month <= params.monthTo)
    .map((c) => ({ month: c.month, direction: c.direction, category: c.category }));

// ---------------------------------------------------------------------------
// FX breakdown
// ---------------------------------------------------------------------------

const DEMO_FX_ROWS: ReadonlyArray<FxBreakdownRow> = [
  { currency: "USD", openNative: 0, openRate: 1, openUsd: 0, deltaNative: 4794.5, closeNative: 4794.5, closeRate: 1, closeUsd: 4794.5, changeUsd: 4794.5 },
  { currency: "EUR", openNative: 0, openRate: 1.0386, openUsd: 0, deltaNative: 755, closeNative: 755, closeRate: 1.035, closeUsd: 781.43, changeUsd: 781.43 },
  { currency: "GBP", openNative: 0, openRate: 1.253, openUsd: 0, deltaNative: 0, closeNative: 0, closeRate: 1.24, closeUsd: 0, changeUsd: 0 },
];

export const getDemoFxBreakdown = (_month: string): FxBreakdownResult => ({
  rows: DEMO_FX_ROWS,
});
