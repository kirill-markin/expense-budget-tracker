"use client";

import {
  ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES,
  ACCOUNT_METADATA_GROUP_VALUES,
  ACCOUNT_METADATA_LIQUIDITY_VALUES,
  type AccountMetadataAccountType,
  type AccountMetadataGroup,
  type AccountMetadataLiquidity,
  isAccountMetadataAccountType,
  isAccountMetadataGroup,
  isAccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";
import { type ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import alertStyles from "@/ui/Alert.module.css";
import controlsStyles from "@/ui/Controls.module.css";
import { useCopyToast } from "@/ui/hooks/useCopyToast";

import type { AccountRow, ConversionWarning, CurrencyTotal } from "@/server/balances/getBalancesSummary";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import { useFormat } from "@/ui/FormatProvider";

import { CellSelectOverlay } from "@/ui/tables/overlays/CellSelectOverlay";
import { DataTable } from "@/ui/tables/shared/data-table/DataTable";
import type { ColumnDef } from "@/ui/tables/shared/data-table/types";
import { useTableSort } from "@/ui/tables/shared/data-table/useTableSort";
import { formatAmount } from "@/ui/tables/shared/format";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import { BalanceSummaryTables } from "./BalanceSummaryTables";
import balancesStyles from "./BalancesTable.module.css";
import {
  fetchBalancesSummary,
  saveAccountGroup,
  saveAccountMetadata,
  withAccountGroup,
  withAccountLiquidity,
  withAccountType,
} from "./balancesTableApi";
import { formatDaysAgoLabel, getDaysAgoValue } from "./balancesTableDaysAgo";
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

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

const LIQUIDITY_OPTIONS: ReadonlyArray<string> = ACCOUNT_METADATA_LIQUIDITY_VALUES;
const ACCOUNT_TYPE_OPTIONS: ReadonlyArray<string> = ACCOUNT_METADATA_ACCOUNT_TYPE_VALUES;
const ACCOUNT_GROUP_OPTIONS: ReadonlyArray<string> = ACCOUNT_METADATA_GROUP_VALUES;

const formatDate = (isoString: string): string => {
  const date = new Date(isoString);
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

export const BalancesTable = (props: Props): ReactElement => {
  const { accounts: accountsProp, totals: totalsProp, conversionWarnings: conversionWarningsProp, reportingCurrency, refreshToken } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const maskClass = effectiveAllowlist !== null ? " data-masked" : "";
  const isMasked = effectiveAllowlist !== null;
  const { toastMessage, copyToClipboard } = useCopyToast();

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

  const [lastTxInfoOpen, setLastTxInfoOpen] = useState<boolean>(false);
  const [statusInfoOpen, setStatusInfoOpen] = useState<boolean>(false);
  const [overdueInfoOpen, setOverdueInfoOpen] = useState<boolean>(false);
  const [showInactive, setShowInactive] = useState<boolean>(false);

  const [liquidityOpen, setLiquidityOpen] = useState<string | null>(null);
  const [liquidityRect, setLiquidityRect] = useState<Rect | null>(null);
  const liquidityCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const [accountTypeOpen, setAccountTypeOpen] = useState<string | null>(null);
  const [accountTypeRect, setAccountTypeRect] = useState<Rect | null>(null);
  const accountTypeCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const [accountGroupOpen, setAccountGroupOpen] = useState<string | null>(null);
  const [accountGroupRect, setAccountGroupRect] = useState<Rect | null>(null);
  const accountGroupCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());

  const handleLiquidityClick = useCallback((accountId: string): void => {
    const cell = liquidityCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
    setAccountGroupOpen(null);
    setAccountGroupRect(null);
    setLiquidityRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setLiquidityOpen(accountId);
  }, []);

  const handleLiquiditySelect = useCallback((accountId: string, oldLiquidity: AccountMetadataLiquidity, accountType: AccountMetadataAccountType, value: string | null): void => {
    setLiquidityOpen(null);
    setLiquidityRect(null);
    if (value === null || value === oldLiquidity) return;
    if (!isAccountMetadataLiquidity(value)) {
      setSaveError(`Invalid liquidity selection: ${value}`);
      return;
    }

    setLocalAccounts((prev) => withAccountLiquidity(prev, accountId, value));
    setSaveError(null);

    saveAccountMetadata(accountId, value, accountType).catch((err) => {
      setLocalAccounts((prev) => withAccountLiquidity(prev, accountId, oldLiquidity));
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const handleLiquidityClose = useCallback((): void => {
    setLiquidityOpen(null);
    setLiquidityRect(null);
  }, []);

  const handleAccountTypeClick = useCallback((accountId: string): void => {
    const cell = accountTypeCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setLiquidityOpen(null);
    setLiquidityRect(null);
    setAccountGroupOpen(null);
    setAccountGroupRect(null);
    setAccountTypeRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setAccountTypeOpen(accountId);
  }, []);

  const handleAccountTypeSelect = useCallback((accountId: string, liquidity: AccountMetadataLiquidity, oldAccountType: AccountMetadataAccountType, value: string | null): void => {
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
    if (value === null || value === oldAccountType) return;
    if (!isAccountMetadataAccountType(value)) {
      setSaveError(`Invalid account type selection: ${value}`);
      return;
    }

    setLocalAccounts((prev) => withAccountType(prev, accountId, value));
    setSaveError(null);

    saveAccountMetadata(accountId, liquidity, value).catch((err) => {
      setLocalAccounts((prev) => withAccountType(prev, accountId, oldAccountType));
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const handleAccountTypeClose = useCallback((): void => {
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
  }, []);

  const handleAccountGroupClick = useCallback((accountId: string): void => {
    const cell = accountGroupCellRefs.current.get(accountId);
    if (cell === undefined) return;
    const r = cell.getBoundingClientRect();
    setLiquidityOpen(null);
    setLiquidityRect(null);
    setAccountTypeOpen(null);
    setAccountTypeRect(null);
    setAccountGroupRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setAccountGroupOpen(accountId);
  }, []);

  const handleAccountGroupSelect = useCallback((accountId: string, oldAccountGroup: AccountMetadataGroup, value: string | null): void => {
    setAccountGroupOpen(null);
    setAccountGroupRect(null);
    if (value === null || value === oldAccountGroup) return;
    if (!isAccountMetadataGroup(value)) {
      setSaveError(`Invalid account group selection: ${value}`);
      return;
    }

    setLocalAccounts((prev) => withAccountGroup(prev, accountId, value));
    setSaveError(null);

    saveAccountGroup(accountId, value).catch((err) => {
      setLocalAccounts((prev) => withAccountGroup(prev, accountId, oldAccountGroup));
      setSaveError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const handleAccountGroupClose = useCallback((): void => {
    setAccountGroupOpen(null);
    setAccountGroupRect(null);
  }, []);

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
  const getAccountGroupLabel = (accountGroup: AccountMetadataGroup): string =>
    t(`balances.accountGroup${accountGroup.charAt(0).toUpperCase()}${accountGroup.slice(1)}`);

  const accountsColumns: ReadonlyArray<ColumnDef<AccountRow>> = [
    {
      key: "accountId",
      header: t("table.account"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="accountId" className={cn(tableStyles.cell, tableStyles.cellMono, "copyable-cell", maskClass)} onClick={() => copyToClipboard(a.accountId)}>
          {a.accountId}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountId",
    },
    {
      key: "currency",
      header: t("table.currency"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="currency" className={cn(tableStyles.cell, maskClass)}>{a.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "liquidity",
      header: t("balances.liquidity"),
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="liquidity"
          ref={(el) => {
            if (el !== null) liquidityCellRefs.current.set(a.accountId, el);
            else liquidityCellRefs.current.delete(a.accountId);
          }}
          className={cn(tableStyles.cell, !isMasked ? tableStyles.editable : "", !isMasked ? tableStyles.editableSelect : "", maskClass)}
          onClick={isMasked ? undefined : () => handleLiquidityClick(a.accountId)}
        >
          {a.liquidity}
          {liquidityOpen === a.accountId && liquidityRect !== null && (
            <CellSelectOverlay
              options={LIQUIDITY_OPTIONS}
              currentValue={a.liquidity}
              allowEmpty={false}
              rect={liquidityRect}
              onSelect={(value) => handleLiquiditySelect(a.accountId, a.liquidity, a.accountType, value)}
              onClose={handleLiquidityClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "accountType",
      header: t("balances.accountType"),
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="accountType"
          ref={(el) => {
            if (el !== null) accountTypeCellRefs.current.set(a.accountId, el);
            else accountTypeCellRefs.current.delete(a.accountId);
          }}
          className={cn(tableStyles.cell, !isMasked ? tableStyles.editable : "", !isMasked ? tableStyles.editableSelect : "", maskClass)}
          onClick={isMasked ? undefined : () => handleAccountTypeClick(a.accountId)}
        >
          {t(`balances.accountType${a.accountType.charAt(0).toUpperCase()}${a.accountType.slice(1)}`)}
          {accountTypeOpen === a.accountId && accountTypeRect !== null && (
            <CellSelectOverlay
              options={ACCOUNT_TYPE_OPTIONS}
              currentValue={a.accountType}
              allowEmpty={false}
              rect={accountTypeRect}
              onSelect={(value) => handleAccountTypeSelect(a.accountId, a.liquidity, a.accountType, value)}
              onClose={handleAccountTypeClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountType",
    },
    {
      key: "accountGroup",
      header: t("balances.accountGroup"),
      renderCell: (a: AccountRow): ReactElement => (
        <td
          key="accountGroup"
          ref={(el) => {
            if (el !== null) accountGroupCellRefs.current.set(a.accountId, el);
            else accountGroupCellRefs.current.delete(a.accountId);
          }}
          className={cn(tableStyles.cell, !isMasked ? tableStyles.editable : "", !isMasked ? tableStyles.editableSelect : "", maskClass)}
          onClick={isMasked ? undefined : () => handleAccountGroupClick(a.accountId)}
        >
          {getAccountGroupLabel(a.accountGroup)}
          {accountGroupOpen === a.accountId && accountGroupRect !== null && (
            <CellSelectOverlay
              options={ACCOUNT_GROUP_OPTIONS}
              currentValue={a.accountGroup}
              allowEmpty={false}
              rect={accountGroupRect}
              onSelect={(value) => handleAccountGroupSelect(a.accountId, a.accountGroup, value)}
              onClose={handleAccountGroupClose}
            />
          )}
        </td>
      ),
      rightAlign: false,
      sortKey: "accountGroup",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(a.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceReport",
      header: t("balances.balanceCurrency", { currency: reportingCurrency }),
      renderCell: (a: AccountRow): ReactElement => (
        <td key="balanceReport" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>
          {a.balanceReport !== null ? formatAmount(a.balanceReport, numberFormat) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceReport",
    },
    {
      key: "lastTransactionTs",
      header: (
        <span style={{ position: "relative" }}>
          {t("balances.lastTransaction")}
          <span
            className={balancesStyles.infoIcon}
            onClick={(e) => { e.stopPropagation(); setLastTxInfoOpen(!lastTxInfoOpen); }}
          >
            &#9432;
          </span>
          {lastTxInfoOpen && (
            <div className={balancesStyles.infoPopup}>
              {t("balances.lastTransactionInfo")}
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="lastTx" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>
            {a.lastTransactionTs !== null ? formatDate(a.lastTransactionTs) : "\u2014"}
          </td>
        );
      },
      rightAlign: false,
      sortKey: "lastTransactionTs",
    },
    {
      key: "daysAgo",
      header: t("balances.daysAgo"),
      renderCell: (a: AccountRow): ReactElement => {
        const days = a.lastTransactionTs !== null ? getDaysAgoValue(a.lastTransactionTs, new Date()) : null;
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="daysAgo" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>
            {days !== null ? formatDaysAgoLabel(days, t) : "\u2014"}
          </td>
        );
      },
      rightAlign: false,
      sortKey: "daysAgo",
    },
    {
      key: "status",
      header: (
        <span style={{ position: "relative" }}>
          {t("balances.status")}
          <span
            className={balancesStyles.infoIcon}
            onClick={(e) => { e.stopPropagation(); setStatusInfoOpen(!statusInfoOpen); }}
          >
            &#9432;
          </span>
          {statusInfoOpen && (
            <div className={balancesStyles.infoPopup}>
              {t("balances.statusInfo")}
            </div>
          )}
        </span>
      ),
      renderCell: (a: AccountRow): ReactElement => {
        const isInactive = a.status === "inactive";
        return (
          <td key="status" className={cn(tableStyles.cell, maskClass, isInactive ? balancesStyles.statusInactive : "")}>{a.status}</td>
        );
      },
      rightAlign: false,
      sortKey: "status",
    },
    {
      key: "freshness",
      header: t("balances.freshness"),
      renderCell: (a: AccountRow): ReactElement => {
        const isStale = a.overdue && a.status === "active";
        return (
          <td key="freshness" className={cn(tableStyles.cell, maskClass, isStale ? balancesStyles.stale : "")}>{isStale ? t("balances.freshnessOverdue") : "\u2014"}</td>
        );
      },
      rightAlign: false,
      sortKey: "freshness",
    },
  ];

  const accountRowClassName = (a: AccountRow): string => {
    return cn(tableStyles.row, a.status === "inactive" ? balancesStyles.rowInactive : "");
  };

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

      <h2 className={balancesStyles.sectionTitle} style={{ position: "relative", display: "inline-block" }}>
        {t("balances.accounts")}
        <span
          className={balancesStyles.infoIcon}
          onClick={() => setOverdueInfoOpen(!overdueInfoOpen)}
        >
          &#9432;
        </span>
        {overdueInfoOpen && (
          <div className={balancesStyles.infoPopup}>
            {t("balances.overdueInfo")}
          </div>
        )}
      </h2>
      <div className={tableStyles.scroll}>
        <DataTable<AccountRow>
          columns={accountsColumns}
          rows={sortedAccounts}
          rowKey={(a) => a.accountId}
          sort={accountsSort.sort}
          onSort={accountsSort.onSort}
          emptyMessage={t("balances.noAccountData")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          rowClassName={accountRowClassName}
        />
      </div>
      {inactiveCount > 0 && (
        <button
          className={controlsStyles.segment}
          type="button"
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive
            ? t("balances.hideInactive", { count: inactiveCount })
            : t("balances.showInactive", { count: inactiveCount })}
        </button>
      )}
      {toastMessage !== null && <div className="copy-toast">{toastMessage}</div>}
    </>
  );
};
