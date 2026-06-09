import type {
  AccountMetadataAccountType,
  AccountMetadataGroup,
  AccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";

import type { AccountRow, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import type { SortEntry, SortState } from "@/ui/tables/shared/data-table/types";

import { compareDaysAgoTimestamps } from "./balancesTableDaysAgo";

type SortDirection = SortEntry["dir"];

export type TotalsSortKey = "currency" | "balance" | "balancePositive" | "balanceNegative" | "balanceReport";

export type LiquidityTotal = Readonly<{
  liquidity: AccountMetadataLiquidity;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  accountCount: number;
}>;

export type AccountGroupTotal = Readonly<{
  accountGroup: AccountMetadataGroup;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  accountCount: number;
}>;

export type LiquiditySortKey = "liquidity" | "balance" | "balancePositive" | "balanceNegative" | "accountCount";
export type AccountGroupSortKey = "accountGroup" | "balance" | "balancePositive" | "balanceNegative" | "accountCount";

export type AccountsSortKey = "accountId" | "currency" | "liquidity" | "accountType" | "accountGroup" | "balance" | "balanceReport" | "lastTransactionTs" | "daysAgo" | "status" | "freshness";

type AccountTotalAccumulator = Readonly<{
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  accountCount: number;
}>;

export const LIQUIDITY_ORDER: Readonly<Record<AccountMetadataLiquidity, number>> = { high: 0, medium: 1, low: 2 };
export const ACCOUNT_TYPE_ORDER: Readonly<Record<AccountMetadataAccountType, number>> = { personal: 0, business: 1 };
export const ACCOUNT_GROUP_ORDER: Readonly<Record<AccountMetadataGroup, number>> = { regular: 0, investment: 1 };

export const TOTALS_SORT_DEFAULTS: Readonly<Record<string, SortDirection>> = {
  currency: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  balanceReport: "desc",
};

export const LIQUIDITY_SORT_DEFAULTS: Readonly<Record<string, SortDirection>> = {
  liquidity: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  accountCount: "desc",
};

export const ACCOUNT_GROUP_SORT_DEFAULTS: Readonly<Record<string, SortDirection>> = {
  accountGroup: "asc",
  balancePositive: "desc",
  balanceNegative: "desc",
  balance: "desc",
  accountCount: "desc",
};

export const ACCOUNTS_SORT_DEFAULTS: Readonly<Record<string, SortDirection>> = {
  accountId: "asc",
  currency: "asc",
  liquidity: "asc",
  accountType: "asc",
  accountGroup: "asc",
  balance: "desc",
  balanceReport: "desc",
  lastTransactionTs: "asc",
  daysAgo: "asc",
  status: "asc",
  freshness: "desc",
};

const compareTotals = (a: CurrencyTotal, b: CurrencyTotal, key: TotalsSortKey, dir: SortDirection): number => {
  let cmp = 0;
  switch (key) {
    case "currency":
      cmp = a.currency.localeCompare(b.currency);
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balancePositive":
      cmp = a.balancePositive - b.balancePositive;
      break;
    case "balanceNegative":
      cmp = a.balanceNegative - b.balanceNegative;
      break;
    case "balanceReport":
      cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
  }
  return dir === "asc" ? cmp : -cmp;
};

const compareLiquidityTotals = (a: LiquidityTotal, b: LiquidityTotal, key: LiquiditySortKey, dir: SortDirection): number => {
  let cmp = 0;
  switch (key) {
    case "liquidity":
      cmp = (LIQUIDITY_ORDER[a.liquidity] ?? 0) - (LIQUIDITY_ORDER[b.liquidity] ?? 0);
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balancePositive":
      cmp = a.balancePositive - b.balancePositive;
      break;
    case "balanceNegative":
      cmp = a.balanceNegative - b.balanceNegative;
      break;
    case "accountCount":
      cmp = a.accountCount - b.accountCount;
      break;
  }
  return dir === "asc" ? cmp : -cmp;
};

const compareAccountGroupTotals = (a: AccountGroupTotal, b: AccountGroupTotal, key: AccountGroupSortKey, dir: SortDirection): number => {
  let cmp = 0;
  switch (key) {
    case "accountGroup":
      cmp = ACCOUNT_GROUP_ORDER[a.accountGroup] - ACCOUNT_GROUP_ORDER[b.accountGroup];
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balancePositive":
      cmp = a.balancePositive - b.balancePositive;
      break;
    case "balanceNegative":
      cmp = a.balanceNegative - b.balanceNegative;
      break;
    case "accountCount":
      cmp = a.accountCount - b.accountCount;
      break;
  }
  return dir === "asc" ? cmp : -cmp;
};

const compareAccounts = (a: AccountRow, b: AccountRow, key: AccountsSortKey, dir: SortDirection, now: Date): number => {
  let cmp = 0;
  switch (key) {
    case "accountId":
      cmp = a.accountId.localeCompare(b.accountId);
      break;
    case "currency":
      cmp = a.currency.localeCompare(b.currency);
      break;
    case "liquidity":
      cmp = (LIQUIDITY_ORDER[a.liquidity] ?? 0) - (LIQUIDITY_ORDER[b.liquidity] ?? 0);
      break;
    case "accountType":
      cmp = ACCOUNT_TYPE_ORDER[a.accountType] - ACCOUNT_TYPE_ORDER[b.accountType];
      break;
    case "accountGroup":
      cmp = ACCOUNT_GROUP_ORDER[a.accountGroup] - ACCOUNT_GROUP_ORDER[b.accountGroup];
      break;
    case "balance":
      cmp = a.balance - b.balance;
      break;
    case "balanceReport":
      cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
    case "lastTransactionTs": {
      const aTs = a.lastTransactionTs ?? "";
      const bTs = b.lastTransactionTs ?? "";
      cmp = aTs.localeCompare(bTs);
      break;
    }
    case "daysAgo":
      cmp = compareDaysAgoTimestamps(a.lastTransactionTs, b.lastTransactionTs, now);
      break;
    case "status":
      cmp = a.status.localeCompare(b.status);
      break;
    case "freshness": {
      const aOverdue = a.overdue ? 1 : 0;
      const bOverdue = b.overdue ? 1 : 0;
      cmp = aOverdue - bOverdue;
      if (cmp === 0) cmp = (a.balanceReport ?? -Infinity) - (b.balanceReport ?? -Infinity);
      break;
    }
  }
  return dir === "asc" ? cmp : -cmp;
};

const applySort = <T>(
  rows: ReadonlyArray<T>,
  sort: SortState,
  compare: (a: T, b: T, entry: SortEntry) => number,
): ReadonlyArray<T> => {
  return [...rows].sort((a, b) => {
    for (const entry of sort) {
      const cmp = compare(a, b, entry);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
};

const addBalanceToAccumulator = (
  accumulator: AccountTotalAccumulator | null,
  balanceReport: number,
): AccountTotalAccumulator => {
  const previous = accumulator ?? {
    balance: 0,
    balancePositive: 0,
    balanceNegative: 0,
    accountCount: 0,
  };

  return {
    balance: previous.balance + balanceReport,
    balancePositive: previous.balancePositive + (balanceReport > 0 ? balanceReport : 0),
    balanceNegative: previous.balanceNegative + (balanceReport < 0 ? balanceReport : 0),
    accountCount: previous.accountCount + 1,
  };
};

export const sortCurrencyTotals = (
  totals: ReadonlyArray<CurrencyTotal>,
  sort: SortState,
): ReadonlyArray<CurrencyTotal> => {
  const nonZeroTotals = totals.filter((total) => total.balance !== 0);
  return applySort(nonZeroTotals, sort, (a, b, entry) => compareTotals(a, b, entry.key as TotalsSortKey, entry.dir));
};

export const buildSortedLiquidityTotals = (
  accounts: ReadonlyArray<AccountRow>,
  sort: SortState,
): ReadonlyArray<LiquidityTotal> => {
  const groups: Map<AccountMetadataLiquidity, AccountTotalAccumulator> = new Map();
  for (const account of accounts) {
    if (account.status !== "active") continue;
    const balanceReport = account.balanceReport ?? 0;
    const existing = groups.get(account.liquidity) ?? null;
    groups.set(account.liquidity, addBalanceToAccumulator(existing, balanceReport));
  }

  const rows: ReadonlyArray<LiquidityTotal> = Array.from(groups.entries()).map(([liquidity, total]) => ({
    liquidity,
    balance: total.balance,
    balancePositive: total.balancePositive,
    balanceNegative: total.balanceNegative,
    accountCount: total.accountCount,
  }));

  return applySort(rows, sort, (a, b, entry) => compareLiquidityTotals(a, b, entry.key as LiquiditySortKey, entry.dir));
};

export const buildSortedAccountGroupTotals = (
  accounts: ReadonlyArray<AccountRow>,
  sort: SortState,
): ReadonlyArray<AccountGroupTotal> => {
  const groups: Map<AccountMetadataGroup, AccountTotalAccumulator> = new Map();
  for (const account of accounts) {
    if (account.status !== "active") continue;
    const balanceReport = account.balanceReport ?? 0;
    const existing = groups.get(account.accountGroup) ?? null;
    groups.set(account.accountGroup, addBalanceToAccumulator(existing, balanceReport));
  }

  const rows: ReadonlyArray<AccountGroupTotal> = Array.from(groups.entries()).map(([accountGroup, total]) => ({
    accountGroup,
    balance: total.balance,
    balancePositive: total.balancePositive,
    balanceNegative: total.balanceNegative,
    accountCount: total.accountCount,
  }));

  return applySort(rows, sort, (a, b, entry) => compareAccountGroupTotals(a, b, entry.key as AccountGroupSortKey, entry.dir));
};

export const filterAndSortAccounts = (
  accounts: ReadonlyArray<AccountRow>,
  showInactive: boolean,
  sort: SortState,
  now: Date,
): ReadonlyArray<AccountRow> => {
  const filtered = showInactive ? accounts : accounts.filter((account) => account.status === "active");
  return [...filtered].sort((a, b) => {
    if (showInactive) {
      const aInactive = a.status !== "active" ? 1 : 0;
      const bInactive = b.status !== "active" ? 1 : 0;
      if (aInactive !== bInactive) return aInactive - bInactive;
    }
    for (const entry of sort) {
      const cmp = compareAccounts(a, b, entry.key as AccountsSortKey, entry.dir, now);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
};

export const sumConvertedBalance = (totals: ReadonlyArray<CurrencyTotal>): number | null => {
  let sum = 0;
  let hasNull = false;
  for (const total of totals) {
    if (total.balanceReport === null) {
      hasNull = true;
    } else {
      sum += total.balanceReport;
    }
  }
  if (hasNull) return null;
  return sum;
};

export const sumPositiveConvertedBalance = (totals: ReadonlyArray<CurrencyTotal>): number => {
  let sum = 0;
  for (const total of totals) {
    if (total.balanceReport !== null && total.balanceReport > 0) sum += total.balanceReport;
    else if (total.balanceReport === null && total.balance > 0) sum += total.balancePositive;
  }
  return sum;
};

export const sumNegativeConvertedBalance = (totals: ReadonlyArray<CurrencyTotal>): number => {
  let sum = 0;
  for (const total of totals) {
    if (total.balanceReport !== null && total.balanceReport < 0) sum += total.balanceReport;
    else if (total.balanceReport === null && total.balance < 0) sum += total.balanceNegative;
  }
  return sum;
};
