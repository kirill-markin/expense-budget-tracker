"use client";

import {
  type AccountMetadataGroup,
  type AccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";
import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import type { NumberFormat } from "@/lib/locale";
import type { CurrencyTotal } from "@/server/balances/getBalancesSummary";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import { DataTable } from "@/ui/tables/shared/data-table/DataTable";
import type { ColumnDef, SortState } from "@/ui/tables/shared/data-table/types";
import { formatAmount } from "@/ui/tables/shared/format";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import balancesStyles from "./BalancesTable.module.css";

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

type BalanceSummaryTablesProps = Readonly<{
  sortedTotals: ReadonlyArray<CurrencyTotal>;
  sortedLiquidityTotals: ReadonlyArray<LiquidityTotal>;
  sortedAccountGroupTotals: ReadonlyArray<AccountGroupTotal>;
  totalsSort: SortState;
  onTotalsSort: (sortKey: string) => void;
  liquiditySort: SortState;
  onLiquiditySort: (sortKey: string) => void;
  accountGroupSort: SortState;
  onAccountGroupSort: (sortKey: string) => void;
  reportingCurrency: string;
  numberFormat: NumberFormat;
  maskClass: string;
  totalUsd: number | null;
  totalPositiveUsd: number;
  totalNegativeUsd: number;
}>;

export const BalanceSummaryTables = (props: BalanceSummaryTablesProps): ReactElement => {
  const {
    sortedTotals,
    sortedLiquidityTotals,
    sortedAccountGroupTotals,
    totalsSort,
    onTotalsSort,
    liquiditySort,
    onLiquiditySort,
    accountGroupSort,
    onAccountGroupSort,
    reportingCurrency,
    numberFormat,
    maskClass,
    totalUsd,
    totalPositiveUsd,
    totalNegativeUsd,
  } = props;
  const { t } = useTranslation();
  const getAccountGroupLabel = (accountGroup: AccountMetadataGroup): string =>
    t(`balances.accountGroup${accountGroup.charAt(0).toUpperCase()}${accountGroup.slice(1)}`);

  const totalsColumns: ReadonlyArray<ColumnDef<CurrencyTotal>> = [
    {
      key: "currency",
      header: t("table.currency"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="currency" className={cn(tableStyles.cell, maskClass)}>{row.currency}</td>
      ),
      rightAlign: false,
      sortKey: "currency",
    },
    {
      key: "balancePositive",
      header: t("balances.totalPlus"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balancePositive" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balancePositive, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: t("balances.totalMinus"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balanceNegative" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balanceNegative, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "balanceReport",
      header: t("balances.equivalent", { currency: reportingCurrency }),
      renderCell: (row: CurrencyTotal): ReactElement => (
        <td key="balanceReport" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass, row.hasUnconvertible ? tableStateStyles.error : "")}>
          {row.balanceReport !== null ? formatAmount(row.balanceReport, numberFormat) : "\u2014"}
        </td>
      ),
      rightAlign: true,
      sortKey: "balanceReport",
    },
  ];

  const totalsFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className={cn(tableStyles.row, tableStyles.rowTotal)}>
      <td className={cn(tableStyles.cell, tableStyles.cellBold)}>{t("balances.total", { currency: reportingCurrency })}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalPositiveUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalNegativeUsd, numberFormat)}</td>
      <td className={tableStyles.cell} />
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>
        {totalUsd !== null ? formatAmount(totalUsd, numberFormat) : "\u2014"}
      </td>
    </tr>,
  ];

  const liquidityColumns: ReadonlyArray<ColumnDef<LiquidityTotal>> = [
    {
      key: "liquidity",
      header: t("balances.liquidity"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="liquidity" className={cn(tableStyles.cell, maskClass)}>{row.liquidity}</td>
      ),
      rightAlign: false,
      sortKey: "liquidity",
    },
    {
      key: "balancePositive",
      header: t("balances.totalPlus"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balancePositive" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balancePositive, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: t("balances.totalMinus"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balanceNegative" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balanceNegative, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "accountCount",
      header: t("balances.accountCount"),
      renderCell: (row: LiquidityTotal): ReactElement => (
        <td key="accountCount" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{row.accountCount}</td>
      ),
      rightAlign: true,
      sortKey: "accountCount",
    },
  ];

  const liquidityFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className={cn(tableStyles.row, tableStyles.rowTotal)}>
      <td className={cn(tableStyles.cell, tableStyles.cellBold)}>{t("balances.total", { currency: reportingCurrency })}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalPositiveUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalNegativeUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>
        {totalUsd !== null ? formatAmount(totalUsd, numberFormat) : "\u2014"}
      </td>
      <td className={tableStyles.cell} />
    </tr>,
  ];

  const accountGroupColumns: ReadonlyArray<ColumnDef<AccountGroupTotal>> = [
    {
      key: "accountGroup",
      header: t("balances.accountGroup"),
      renderCell: (row: AccountGroupTotal): ReactElement => (
        <td key="accountGroup" className={cn(tableStyles.cell, maskClass)}>{getAccountGroupLabel(row.accountGroup)}</td>
      ),
      rightAlign: false,
      sortKey: "accountGroup",
    },
    {
      key: "balancePositive",
      header: t("balances.totalPlus"),
      renderCell: (row: AccountGroupTotal): ReactElement => (
        <td key="balancePositive" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balancePositive, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balancePositive",
    },
    {
      key: "balanceNegative",
      header: t("balances.totalMinus"),
      renderCell: (row: AccountGroupTotal): ReactElement => (
        <td key="balanceNegative" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balanceNegative, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balanceNegative",
    },
    {
      key: "balance",
      header: t("balances.balance"),
      renderCell: (row: AccountGroupTotal): ReactElement => (
        <td key="balance" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{formatAmount(row.balance, numberFormat)}</td>
      ),
      rightAlign: true,
      sortKey: "balance",
    },
    {
      key: "accountCount",
      header: t("balances.accountCount"),
      renderCell: (row: AccountGroupTotal): ReactElement => (
        <td key="accountCount" className={cn(tableStyles.cell, tableStyles.cellRight, maskClass)}>{row.accountCount}</td>
      ),
      rightAlign: true,
      sortKey: "accountCount",
    },
  ];

  const accountGroupFooterRows: ReadonlyArray<ReactElement> = [
    <tr key="total" className={cn(tableStyles.row, tableStyles.rowTotal)}>
      <td className={cn(tableStyles.cell, tableStyles.cellBold)}>{t("balances.total", { currency: reportingCurrency })}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalPositiveUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>{formatAmount(totalNegativeUsd, numberFormat)}</td>
      <td className={cn(tableStyles.cell, tableStyles.cellRight, tableStyles.cellBold, maskClass)}>
        {totalUsd !== null ? formatAmount(totalUsd, numberFormat) : "\u2014"}
      </td>
      <td className={tableStyles.cell} />
    </tr>,
  ];

  return (
    <>
      <h2 className={balancesStyles.sectionTitle}>{t("balances.byCurrency")}</h2>
      <div className={tableStyles.scroll}>
        <DataTable<CurrencyTotal>
          columns={totalsColumns}
          rows={sortedTotals}
          rowKey={(row) => row.currency}
          sort={totalsSort}
          onSort={onTotalsSort}
          emptyMessage={t("balances.noCurrencyTotals")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={totalsFooterRows}
        />
      </div>

      <h2 className={balancesStyles.sectionTitle}>{t("balances.byLiquidity")}</h2>
      <div className={tableStyles.scroll}>
        <DataTable<LiquidityTotal>
          columns={liquidityColumns}
          rows={sortedLiquidityTotals}
          rowKey={(row) => row.liquidity}
          sort={liquiditySort}
          onSort={onLiquiditySort}
          emptyMessage={t("balances.noLiquidityData")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={liquidityFooterRows}
        />
      </div>

      <h2 className={balancesStyles.sectionTitle}>{t("balances.byAccountGroup")}</h2>
      <div className={tableStyles.scroll}>
        <DataTable<AccountGroupTotal>
          columns={accountGroupColumns}
          rows={sortedAccountGroupTotals}
          rowKey={(row) => row.accountGroup}
          sort={accountGroupSort}
          onSort={onAccountGroupSort}
          emptyMessage={t("balances.noAccountGroupData")}
          loading={false}
          loadingMore={false}
          sentinelRef={null}
          footerRows={accountGroupFooterRows}
        />
      </div>
    </>
  );
};
