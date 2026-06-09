"use client";

import { type ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import alertStyles from "@/ui/Alert.module.css";

import type { AccountRow, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import { useFormat } from "@/ui/FormatProvider";

import { useTableSort } from "@/ui/tables/shared/data-table/useTableSort";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import { BalanceAccountsTable } from "./BalanceAccountsTable";
import { BalanceSummaryTables } from "./BalanceSummaryTables";
import { fetchBalancesSummary } from "./balancesTableApi";
import {
  ACCOUNTS_SORT_DEFAULTS,
  ACCOUNT_GROUP_SORT_DEFAULTS,
  LIQUIDITY_SORT_DEFAULTS,
  TOTALS_SORT_DEFAULTS,
  buildSortedAccountGroupTotals,
  buildSortedLiquidityTotals,
  filterAndSortAccounts,
  sortCurrencyTotals,
  sumConvertedBalance,
  sumNegativeConvertedBalance,
  sumPositiveConvertedBalance,
  type AccountGroupTotal,
  type LiquidityTotal,
} from "./balancesTableModel";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  reportingCurrency: string;
  refreshToken: string;
}>;

export const BalancesTable = (props: Props): ReactElement => {
  const { accounts: accountsProp, totals: totalsProp, conversionWarnings: conversionWarningsProp, reportingCurrency, refreshToken } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const maskClass = effectiveAllowlist !== null ? " data-masked" : "";

  const [localAccounts, setLocalAccounts] = useState<ReadonlyArray<AccountRow>>(accountsProp);
  const [localTotals, setLocalTotals] = useState<ReadonlyArray<CurrencyTotal>>(totalsProp);
  const [localConversionWarnings, setLocalConversionWarnings] = useState<ReadonlyArray<ConversionWarning>>(conversionWarningsProp);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const refreshTokenRef = useRef<string>(refreshToken);

  useEffect(() => {
    setLocalAccounts(accountsProp);
    setLocalTotals(totalsProp);
    setLocalConversionWarnings(conversionWarningsProp);
    setLoadError(null);
  }, [accountsProp, conversionWarningsProp, totalsProp]);

  useEffect(() => {
    if (refreshTokenRef.current === refreshToken) {
      return;
    }

    refreshTokenRef.current = refreshToken;
    let ignoreResult = false;

    fetchBalancesSummary(refreshToken)
      .then((summary) => {
        if (ignoreResult) {
          return;
        }

        setLocalAccounts(summary.accounts);
        setLocalTotals(summary.totals);
        setLocalConversionWarnings(summary.conversionWarnings);
        setLoadError(null);
      })
      .catch((err) => {
        if (ignoreResult) {
          return;
        }

        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      ignoreResult = true;
    };
  }, [refreshToken]);

  const totalsSort = useTableSort("multi", "balanceReport", "desc", TOTALS_SORT_DEFAULTS);
  const liquiditySort = useTableSort("multi", "liquidity", "asc", LIQUIDITY_SORT_DEFAULTS);
  const accountGroupSort = useTableSort("multi", "accountGroup", "asc", ACCOUNT_GROUP_SORT_DEFAULTS);
  const accountsSort = useTableSort("multi", "freshness", "desc", ACCOUNTS_SORT_DEFAULTS);

  const [showInactive, setShowInactive] = useState<boolean>(false);

  const sortedTotals = useMemo<ReadonlyArray<CurrencyTotal>>(
    () => sortCurrencyTotals(localTotals, totalsSort.sort),
    [localTotals, totalsSort.sort],
  );

  const sortedLiquidityTotals = useMemo<ReadonlyArray<LiquidityTotal>>(
    () => buildSortedLiquidityTotals(localAccounts, liquiditySort.sort),
    [localAccounts, liquiditySort.sort],
  );

  const sortedAccountGroupTotals = useMemo<ReadonlyArray<AccountGroupTotal>>(
    () => buildSortedAccountGroupTotals(localAccounts, accountGroupSort.sort),
    [accountGroupSort.sort, localAccounts],
  );

  const inactiveCount = useMemo<number>(
    () => localAccounts.filter((a) => a.status !== "active").length,
    [localAccounts],
  );

  const sortedAccounts = useMemo<ReadonlyArray<AccountRow>>(
    () => filterAndSortAccounts(localAccounts, showInactive, accountsSort.sort, new Date()),
    [localAccounts, accountsSort.sort, showInactive],
  );

  const totalUsd = useMemo<number | null>(() => sumConvertedBalance(localTotals), [localTotals]);
  const totalPositiveUsd = useMemo<number>(() => sumPositiveConvertedBalance(localTotals), [localTotals]);
  const totalNegativeUsd = useMemo<number>(() => sumNegativeConvertedBalance(localTotals), [localTotals]);

  if (localAccounts.length === 0) {
    return (
      <>
        {loadError !== null && (
          <div className={alertStyles.alert}>
            <strong>{t("balances.loadFailed")}</strong>
            <span>{loadError}</span>
          </div>
        )}
        <p className={tableStyles.empty}>{t("balances.noData")}</p>
      </>
    );
  }

  const currencyList = localConversionWarnings.map((w) => w.currency).join(", ");

  return (
    <>
      {localConversionWarnings.length > 0 && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.conversionTitle")}</strong>
          <span>
            {t("balances.conversionMessage", {
              currencies: currencyList,
              qualifier: localConversionWarnings.length === 1 ? t("balances.conversionSingular") : t("balances.conversionPlural"),
              currency: reportingCurrency,
            })}
          </span>
        </div>
      )}
      {loadError !== null && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.loadFailed")}</strong>
          <span>{loadError}</span>
        </div>
      )}
      {saveError !== null && (
        <div className={alertStyles.alert}>
          <strong>{t("balances.saveFailed")}</strong>
          <span>{saveError}</span>
        </div>
      )}
      <BalanceSummaryTables
        sortedTotals={sortedTotals}
        sortedLiquidityTotals={sortedLiquidityTotals}
        sortedAccountGroupTotals={sortedAccountGroupTotals}
        totalsSort={totalsSort.sort}
        onTotalsSort={totalsSort.onSort}
        liquiditySort={liquiditySort.sort}
        onLiquiditySort={liquiditySort.onSort}
        accountGroupSort={accountGroupSort.sort}
        onAccountGroupSort={accountGroupSort.onSort}
        reportingCurrency={reportingCurrency}
        numberFormat={numberFormat}
        maskClass={maskClass}
        totalUsd={totalUsd}
        totalPositiveUsd={totalPositiveUsd}
        totalNegativeUsd={totalNegativeUsd}
      />

      <BalanceAccountsTable
        accounts={sortedAccounts}
        accountsSort={accountsSort.sort}
        onAccountsSort={accountsSort.onSort}
        showInactive={showInactive}
        setShowInactive={setShowInactive}
        inactiveCount={inactiveCount}
        reportingCurrency={reportingCurrency}
        setLocalAccounts={setLocalAccounts}
        setSaveError={setSaveError}
      />
    </>
  );
};
