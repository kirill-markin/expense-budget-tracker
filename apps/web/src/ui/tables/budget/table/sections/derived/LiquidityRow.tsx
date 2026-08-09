"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
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
  renderMaskedYearCells,
} from "../shared";

type LiquidityRowProps = Readonly<{
  liquidity: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
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
  const renderYearLoading = (year: string, isCurrentYearValue: boolean): ReactElement => (
    showData
      ? renderDerivedYearLoadingCells(year, isCurrentYearValue)
      : renderMaskedYearCells(year, isCurrentYearValue, derivedMaskClass)
  );

  return (
    <tr key={`bal-${liquidity}`} className={styles.categoryRow}>
      <td className={`${styles.categoryLabel} ${styles.stickyCol}${derivedMaskClass}`}>
        {showData
          ? t(`budget.liquidity${liquidity.charAt(0).toUpperCase()}${liquidity.slice(1)}`)
          : MASKED_CELL_PLACEHOLDER}
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
            renderYearLoading(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
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
          renderCurrentYear: () => {
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
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {renderValue(mebByLiq[column.month]?.[liquidity] ?? 0)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {renderValue(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0)}
              </td>
            );
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            return (
              <Fragment key={column.month}>
                <td className={`${styles.cell} ${styles.currentMonthPlan}${derivedMaskClass}`}>
                  {renderValue(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0)}
                </td>
                <td className={`${styles.cell} ${styles.currentMonthActual}${derivedMaskClass}`}>
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
