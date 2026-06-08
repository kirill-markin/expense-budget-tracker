"use client";

import type { ReactElement } from "react";

import {
  type ColumnEntry,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import {
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderSubtotalYearLoadingCells,
} from "../shared";

type MetricRowProps = Readonly<{
  label: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  renderPastYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderFutureYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderCurrentYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderPastMonth: (month: string) => ReactElement;
  renderFutureMonth: (month: string) => ReactElement;
  renderCurrentMonth: (month: string) => ReactElement;
  loadingKind: "subtotal" | "derived";
  rowClassName: string;
}>;

export const MetricRow = (props: MetricRowProps): ReactElement => {
  const {
    label,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    rowClassName,
    renderPastYear,
    renderFutureYear,
    renderCurrentYear,
    renderPastMonth,
    renderFutureMonth,
    renderCurrentMonth,
    loadingKind,
  } = props;
  const renderLoading = loadingKind === "subtotal" ? renderSubtotalYearLoadingCells : renderDerivedYearLoadingCells;

  return (
    <tr className={rowClassName}>
      <td className={`${rowClassName === styles.directionRow ? styles.directionLabel : styles.categoryLabel} ${styles.stickyCol}`}>{label}</td>
      <td className={styles.leftSpacer} />
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isCurrentYearValue) =>
            renderLoading(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
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
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", true);
            }
            return renderCurrentYear(column.year, yearData);
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
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderCurrentMonth(column.month);
          },
        });
      })}
    </tr>
  );
};
