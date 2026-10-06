"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  type BudgetPlansMode,
  type ColumnEntry,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import {
  buildMonthDividerClass,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderMaskedYearCells,
  renderUnloadedMonthCells,
} from "../shared";

type LiquidityRowProps = Readonly<{
  liquidity: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  numberFormat: NumberFormat;
  showData: boolean;
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
    plansMode,
    loadedFrom,
    loadedTo,
    yearComputed,
    numberFormat,
    showData,
    derivedMaskClass,
    mebByLiq,
    projectedLiqBalances,
  } = props;
  const { t } = useTranslation();
  const renderValue = (value: number): string => (
    showData ? formatAmount(value, numberFormat) : MASKED_CELL_PLACEHOLDER
  );
  const renderYearLoading = (year: string, isSplitYearValue: boolean): ReactElement => (
    showData
      ? renderDerivedYearLoadingCells(year, isSplitYearValue)
      : renderMaskedYearCells(year, isSplitYearValue, derivedMaskClass)
  );

  return (
    <tr key={`bal-${liquidity}`} className={styles.categoryRow}>
      <td className={`${styles.categoryLabel} ${styles.stickyCol}${derivedMaskClass}`}>
        {showData
          ? t(`budget.liquidity${liquidity.charAt(0).toUpperCase()}${liquidity.slice(1)}`)
          : MASKED_CELL_PLACEHOLDER}
      </td>
      {columnSequence.map((column, index) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        const monthDividerClass = buildMonthDividerClass(columnSequence, index, currentMonth, plansMode);
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          plansMode,
          loadedFrom,
          loadedTo,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isSplitYearValue) =>
            renderYearLoading(column.kind === "year-total" ? column.year : "", isSplitYearValue),
          renderMonthLoading: (month) =>
            renderUnloadedMonthCells(month, currentMonth, styles.cell, plansMode, monthDividerClass),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {renderValue(yearData.decemberBalancesByLiquidity[liquidity] ?? 0)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {renderValue(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0)}
              </td>
            );
          },
          renderSplitYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {renderValue(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0)}
                </td>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {renderValue(yearData.decemberBalancesByLiquidity[liquidity] ?? 0)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${monthDividerClass}${derivedMaskClass}`}>
                {renderValue(mebByLiq[column.month]?.[liquidity] ?? 0)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${monthDividerClass}${derivedMaskClass}`}>
                {renderValue(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0)}
              </td>
            );
          },
          renderSplitMonth: (isCurrentMonth) => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            // Only the real current month carries the emphasis box.
            const planEmphasisClass = isCurrentMonth ? ` ${styles.currentMonthPlan}` : "";
            const actualEmphasisClass = isCurrentMonth ? ` ${styles.currentMonthActual}` : "";
            return (
              <Fragment key={column.month}>
                <td className={`${styles.cell}${monthDividerClass}${planEmphasisClass}${derivedMaskClass}`}>
                  {renderValue(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0)}
                </td>
                <td className={`${styles.cell}${actualEmphasisClass}${derivedMaskClass}`}>
                  {renderValue(mebByLiq[column.month]?.[liquidity] ?? 0)}
                </td>
              </Fragment>
            );
          },
        });
      })}
    </tr>
  );
};
