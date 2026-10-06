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
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import {
  buildMonthDividerClass,
  buildYearTotalStateClass,
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
  resolveMonthTaint: (month: string) => Readonly<{ isTainted: boolean; title: string | undefined }>;
  resolveYearTitle: (isTainted: boolean, currencies: ReadonlyArray<string>) => string | undefined;
}>;

/** A cell's untrusted presentation: the state class to append and the hover reason. */
type CellTaint = Readonly<{ stateClass: string; title: string | undefined }>;

const UNTAINTED_CELL: CellTaint = { stateClass: "", title: undefined };

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
    resolveMonthTaint,
    resolveYearTitle,
  } = props;
  const { t } = useTranslation();
  const renderValue = (value: number): string => (
    showData ? formatAmount(value, numberFormat) : MASKED_CELL_PLACEHOLDER
  );
  const renderMonthTaint = (month: string): CellTaint => {
    const taint = resolveMonthTaint(month);
    if (!showData || !taint.isTainted) return UNTAINTED_CELL;
    return { stateClass: ` ${tableStateStyles.warning}`, title: taint.title };
  };
  const renderYearTaint = (yearData: YearTotalComputed): CellTaint => {
    if (!showData) return UNTAINTED_CELL;
    return {
      stateClass: buildYearTotalStateClass(yearData.decemberBalance.isTainted, false),
      title: resolveYearTitle(yearData.decemberBalance.isTainted, yearData.unconvertibleCurrencies),
    };
  };
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
            const yearTaint = renderYearTaint(yearData);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${yearTaint.stateClass}`}
                title={yearTaint.title}
              >
                {renderValue(yearData.decemberBalancesByLiquidity[liquidity] ?? 0)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearTaint = renderYearTaint(yearData);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${yearTaint.stateClass}`}
                title={yearTaint.title}
              >
                {renderValue(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0)}
              </td>
            );
          },
          renderSplitYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            const yearTaint = renderYearTaint(yearData);
            return (
              <Fragment key={`total-${column.year}`}>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${yearTaint.stateClass}`}
                  title={yearTaint.title}
                >
                  {renderValue(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0)}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${yearTaint.stateClass}`}
                  title={yearTaint.title}
                >
                  {renderValue(yearData.decemberBalancesByLiquidity[liquidity] ?? 0)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const monthTaint = renderMonthTaint(column.month);
            return (
              <td
                key={column.month}
                className={`${styles.cell}${monthDividerClass}${derivedMaskClass}${monthTaint.stateClass}`}
                title={monthTaint.title}
              >
                {renderValue(mebByLiq[column.month]?.[liquidity] ?? 0)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const monthTaint = renderMonthTaint(column.month);
            return (
              <td
                key={column.month}
                className={`${styles.cell}${monthDividerClass}${derivedMaskClass}${monthTaint.stateClass}`}
                title={monthTaint.title}
              >
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
            const monthTaint = renderMonthTaint(column.month);
            return (
              <Fragment key={column.month}>
                <td
                  className={`${styles.cell}${monthDividerClass}${planEmphasisClass}${derivedMaskClass}${monthTaint.stateClass}`}
                  title={monthTaint.title}
                >
                  {renderValue(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0)}
                </td>
                <td
                  className={`${styles.cell}${actualEmphasisClass}${derivedMaskClass}${monthTaint.stateClass}`}
                  title={monthTaint.title}
                >
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
