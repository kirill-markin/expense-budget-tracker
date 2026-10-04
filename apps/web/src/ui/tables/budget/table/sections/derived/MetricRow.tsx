"use client";

import type { ReactElement } from "react";

import {
  type BudgetPlansMode,
  type ColumnEntry,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import {
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderMaskedYearCells,
  renderSubtotalYearLoadingCells,
  renderUnloadedMonthCells,
} from "../shared";

type MetricRowProps = Readonly<{
  label: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  renderPastYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderFutureYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderSplitYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderPastMonth: (month: string) => ReactElement;
  renderFutureMonth: (month: string) => ReactElement;
  renderSplitMonth: (month: string, isCurrentMonth: boolean) => ReactElement;
  loadingKind: "subtotal" | "derived";
  showData: boolean;
  maskClass: string;
  rowClassName: string;
}>;

export const MetricRow = (props: MetricRowProps): ReactElement => {
  const {
    label,
    columnSequence,
    currentMonth,
    currentYear,
    plansMode,
    loadedFrom,
    loadedTo,
    yearComputed,
    rowClassName,
    renderPastYear,
    renderFutureYear,
    renderSplitYear,
    renderPastMonth,
    renderFutureMonth,
    renderSplitMonth,
    loadingKind,
    showData,
    maskClass,
  } = props;
  const renderVisibleLoading = loadingKind === "subtotal"
    ? renderSubtotalYearLoadingCells
    : renderDerivedYearLoadingCells;
  const renderLoading = (year: string, isSplitYear: boolean): ReactElement => (
    showData
      ? renderVisibleLoading(year, isSplitYear)
      : renderMaskedYearCells(year, isSplitYear, maskClass)
  );

  return (
    <tr className={rowClassName}>
      <td className={`${rowClassName === styles.directionRow ? styles.directionLabel : styles.categoryLabel} ${styles.stickyCol}`}>{label}</td>
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          plansMode,
          loadedFrom,
          loadedTo,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isSplitYearValue) =>
            renderLoading(column.kind === "year-total" ? column.year : "", isSplitYearValue),
          renderMonthLoading: (month) => renderUnloadedMonthCells(
            month,
            currentMonth,
            loadingKind === "subtotal"
              ? `${styles.cell} ${styles.cellSubtotal}`
              : styles.cell,
            plansMode,
          ),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return renderPastYear(column.year, yearData);
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return renderFutureYear(column.year, yearData);
          },
          renderSplitYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", true);
            }
            return renderSplitYear(column.year, yearData);
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderPastMonth(column.month);
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderFutureMonth(column.month);
          },
          renderSplitMonth: (isCurrentMonth) => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderSplitMonth(column.month, isCurrentMonth);
          },
        });
      })}
    </tr>
  );
};
