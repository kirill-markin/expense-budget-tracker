import {
  type AccountMetadataAccountType,
  type AccountMetadataGroup,
  type AccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";

import { fetchWithCsrf } from "@/lib/csrf";
import { buildLiveDataUrl, fetchLiveData } from "@/lib/liveDataFetch";

import type { AccountRow, BalancesSummaryResult, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";

export type BalancesSummaryState = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
}>;

export const saveAccountMetadata = async (
  accountId: string,
  liquidity: AccountMetadataLiquidity,
  accountType: AccountMetadataAccountType,
): Promise<void> => {
  const response = await fetchWithCsrf("/api/account-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, liquidity, accountType }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save account metadata: ${response.status} ${await response.text()}`);
  }
};

export const saveAccountGroup = async (accountId: string, accountGroup: AccountMetadataGroup): Promise<void> => {
  const response = await fetchWithCsrf("/api/account-metadata/account-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, accountGroup }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save account group: ${response.status} ${await response.text()}`);
  }
};

export const fetchBalancesSummary = async (
  refreshToken: string,
): Promise<BalancesSummaryState> => {
  const response = await fetchLiveData(buildLiveDataUrl("/api/balances-summary", new URLSearchParams(), refreshToken));
  if (!response.ok) {
    throw new Error(`Balances summary refresh failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as BalancesSummaryResult;
  return {
    accounts: payload.accounts,
    totals: payload.totals,
    conversionWarnings: payload.conversionWarnings,
  };
};

export const withAccountLiquidity = (
  accounts: ReadonlyArray<AccountRow>,
  accountId: string,
  liquidity: AccountMetadataLiquidity,
): ReadonlyArray<AccountRow> =>
  accounts.map((account) => account.accountId === accountId ? { ...account, liquidity } : account);

export const withAccountType = (
  accounts: ReadonlyArray<AccountRow>,
  accountId: string,
  accountType: AccountMetadataAccountType,
): ReadonlyArray<AccountRow> =>
  accounts.map((account) => account.accountId === accountId ? { ...account, accountType } : account);

export const withAccountGroup = (
  accounts: ReadonlyArray<AccountRow>,
  accountId: string,
  accountGroup: AccountMetadataGroup,
): ReadonlyArray<AccountRow> =>
  accounts.map((account) => account.accountId === accountId ? { ...account, accountGroup } : account);
