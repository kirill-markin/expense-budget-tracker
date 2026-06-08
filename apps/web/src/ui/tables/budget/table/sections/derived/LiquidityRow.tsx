"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  type ColumnEntry,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import {
  renderColumnCells,
  renderDerivedYearLoadingCells,
} from "../shared";

type LiquidityRowProps = Readonly<{
  liquidity: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  numberFormat: NumberFormat;
  derivedMaskClass: string;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
}>;

export const LiquidityRow = (props: LiquidityRowProps): ReactElement => {
  const {
    liquidity,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    numberFormat,
    derivedMaskClass,
    mebByLiq,
    projectedLiqBalances,
  } = props;
  const { t } = useTranslation();

  return (
    <tr key={`bal-${liquidity}`} className={styles.categoryRow}>
      <td className={`${styles.categoryLabel} ${styles.stickyCol}${derivedMaskClass}`}>
        {t(`budget.liquidity${liquidity.charAt(0).toUpperCase()}${liquidity.slice(1)}`)}
      </td>
      <td className={styles.leftSpacer} />
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isCurrentYearValue) =>
            renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {formatAmount(yearData.decemberBalancesByLiquidity[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {formatAmount(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
            }
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {formatAmount(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0, numberFormat)}
                </td>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {formatAmount(yearData.decemberBalancesByLiquidity[liquidity] ?? 0, numberFormat)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {formatAmount(mebByLiq[column.month]?.[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {formatAmount(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <Fragment key={column.month}>
                <td className={`${styles.cell} ${styles.currentMonthPlan}${derivedMaskClass}`}>
                  {formatAmount(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0, numberFormat)}
                </td>
                <td className={`${styles.cell} ${styles.currentMonthActual}${derivedMaskClass}`}>
                  {formatAmount(mebByLiq[column.month]?.[liquidity] ?? 0, numberFormat)}
                </td>
              </Fragment>
            );
          },
        });
      })}
    </tr>
  );
};
