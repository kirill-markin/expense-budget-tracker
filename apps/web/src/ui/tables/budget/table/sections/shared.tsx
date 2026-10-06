import { Fragment, type ReactElement } from "react";

import { MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  isBudgetMonthLoaded,
  isPastMonth,
  isSplitBudgetMonth,
  isSplitBudgetYear,
  startsBudgetMonthDivider,
  type BudgetPlansMode,
  type ColumnEntry,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import { resolveYearTotalStateTokens, type YearTotalStateToken } from "./yearTotalState";
export {
  buildBusinessPersonalTransferMonthDrillDownFilter,
  buildBusinessPersonalTransferYearDrillDownFilter,
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  isDirectionActualOverPlanned,
  isNegativeValueOver,
} from "../helpers";

/**
 * Class the first cell of a divided month carries, with the leading space the
 * cell class templates expect. Empty for every column that starts no divider.
 */
export const buildMonthDividerClass = (
  columnSequence: ReadonlyArray<ColumnEntry>,
  index: number,
  currentMonth: string,
  plansMode: BudgetPlansMode,
): string => (
  startsBudgetMonthDivider(columnSequence, index, currentMonth, plansMode)
    ? ` ${styles.monthDivider}`
    : ""
);

export type RenderValueCellsParams = Readonly<{
  key: string;
  month: string;
  currentMonth: string;
  plansMode: BudgetPlansMode;
  planned: number;
  actual: number;
  /**
   * Plan values are stored in the report currency and never pass through an
   * exchange rate, so only rows whose plan is derived from actuals set this.
   */
  isPlanTainted: boolean;
  isActualTainted: boolean;
  /** Native hover reason for the untrusted plan cell, or null when it has none. */
  planTitle: string | null;
  /** Native hover reason for the untrusted actual cell, or null when it has none. */
  actualTitle: string | null;
  isPlanOver: boolean;
  isActualOver: boolean;
  isSubtotal: boolean;
  /** Divider carried by the first cell this month renders, or an empty class. */
  monthDividerClass: string;
  maskClass: string;
  plannedValueClass: string;
  actualValueClass: string;
  numberFormat: NumberFormat;
  formatter: (value: number, numberFormat: NumberFormat) => string;
  onActualClick: (() => void) | null;
}>;

export type RenderColumnCellsParams = Readonly<{
  column: ColumnEntry;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  isYearLoading: boolean;
  /** `isSplitYear` tells the loading placeholder how many columns to fill. */
  renderYearLoading: (isSplitYear: boolean) => ReactElement;
  renderMonthLoading: (month: string) => ReactElement;
  renderPastYear: () => ReactElement;
  renderFutureYear: () => ReactElement;
  /** Plan and Actual year columns: the current year, and past years in "all-plans" mode. */
  renderSplitYear: () => ReactElement;
  renderPastMonth: () => ReactElement;
  renderFutureMonth: () => ReactElement;
  /** Plan and Actual month columns; only the real current month is emphasized. */
  renderSplitMonth: (isCurrentMonth: boolean) => ReactElement;
}>;

const YEAR_TOTAL_STATE_CLASSES: Readonly<Record<YearTotalStateToken, string>> = {
  warning: tableStateStyles.warning,
  over: tableStateStyles.over,
  danger: styles.yearTotalDanger,
  warningBackground: styles.yearTotalWarning,
};

/** `isWarning` marks a value that could not be fully converted, never an error. */
export const buildYearTotalStateClass = (isWarning: boolean, isOver: boolean): string => {
  const classNames = resolveYearTotalStateTokens(isWarning, isOver)
    .map((token) => YEAR_TOTAL_STATE_CLASSES[token]);

  return classNames.length > 0 ? ` ${classNames.join(" ")}` : "";
};

export const renderValueCells = (params: RenderValueCellsParams): ReactElement => {
  const {
    key,
    month,
    currentMonth,
    plansMode,
    planned,
    actual,
    isPlanTainted,
    isActualTainted,
    planTitle,
    actualTitle,
    isPlanOver,
    isActualOver,
    isSubtotal,
    monthDividerClass,
    maskClass,
    plannedValueClass,
    actualValueClass,
    numberFormat,
    formatter,
    onActualClick,
  } = params;
  const isMasked = maskClass.includes("data-masked");
  const subtotalClass = isSubtotal ? ` ${styles.cellSubtotal}` : "";
  const plannedTaintedClass = !isMasked && isPlanTainted ? ` ${tableStateStyles.warning}` : "";
  const actualTaintedClass = !isMasked && isActualTainted ? ` ${tableStateStyles.warning}` : "";
  const visiblePlanTitle = isMasked ? undefined : (planTitle ?? undefined);
  const visibleActualTitle = isMasked ? undefined : (actualTitle ?? undefined);
  const visiblePlannedValueClass = isMasked ? "" : plannedValueClass;
  const visibleActualValueClass = isMasked ? "" : actualValueClass;
  const visibleActualClick = isMasked ? null : onActualClick;

  if (!isSplitBudgetMonth(month, currentMonth, plansMode)) {
    if (isPastMonth(month, currentMonth)) {
      const pastClickableClass = visibleActualClick !== null ? ` ${styles.cellClickable}` : "";
      return (
        <td
          key={key}
          className={`${styles.cell}${monthDividerClass}${subtotalClass}${maskClass}${actualTaintedClass}${pastClickableClass} ${visibleActualValueClass}`}
          title={visibleActualTitle}
          onClick={visibleActualClick ?? undefined}
        >
          {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(actual, numberFormat)}
        </td>
      );
    }

    return (
      <td
        key={key}
        className={`${styles.cell}${monthDividerClass}${subtotalClass}${maskClass}${plannedTaintedClass}${!isMasked && isPlanOver ? ` ${tableStateStyles.over}` : ""} ${visiblePlannedValueClass}`}
        title={visiblePlanTitle}
      >
        {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(planned, numberFormat)}
      </td>
    );
  }

  const clickableClass = visibleActualClick !== null ? ` ${styles.cellClickable}` : "";
  // Only the real current month carries the emphasis box.
  const planEmphasisClass = month === currentMonth ? ` ${styles.currentMonthPlan}` : "";
  const actualEmphasisClass = month === currentMonth ? ` ${styles.currentMonthActual}` : "";
  return (
    <Fragment key={key}>
      <td
        className={`${styles.cell}${monthDividerClass}${planEmphasisClass}${subtotalClass}${maskClass}${plannedTaintedClass}${!isMasked && isPlanOver ? ` ${tableStateStyles.over}` : ""} ${visiblePlannedValueClass}`}
        title={visiblePlanTitle}
      >
        {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(planned, numberFormat)}
      </td>
      <td
        className={`${styles.cell}${actualEmphasisClass}${subtotalClass}${maskClass}${actualTaintedClass}${!isMasked && isActualOver ? ` ${tableStateStyles.over}` : ""}${clickableClass} ${visibleActualValueClass}`}
        title={visibleActualTitle}
        onClick={visibleActualClick ?? undefined}
      >
        {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(actual, numberFormat)}
      </td>
    </Fragment>
  );
};

export const renderSubtotalYearLoadingCells = (year: string, isSplitYear: boolean): ReactElement => {
  if (isSplitYear) {
    return (
      <Fragment key={`total-${year}`}>
        <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>
        <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>
      </Fragment>
    );
  }

  return (
    <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>
      &hellip;
    </td>
  );
};

export const renderDerivedYearLoadingCells = (year: string, isSplitYear: boolean): ReactElement => {
  if (isSplitYear) {
    return (
      <Fragment key={`total-${year}`}>
        <td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>
        <td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>
      </Fragment>
    );
  }

  return (
    <td key={`total-${year}`} className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>
      &hellip;
    </td>
  );
};

export const renderMaskedYearCells = (
  year: string,
  isSplitYear: boolean,
  maskClass: string,
): ReactElement => {
  if (isSplitYear) {
    return (
      <Fragment key={`total-${year}`}>
        <td className={`${styles.cell} ${styles.yearTotal}${maskClass}`}>{MASKED_CELL_PLACEHOLDER}</td>
        <td className={`${styles.cell} ${styles.yearTotal}${maskClass}`}>{MASKED_CELL_PLACEHOLDER}</td>
      </Fragment>
    );
  }

  return (
    <td key={`total-${year}`} className={`${styles.cell} ${styles.yearTotal}${maskClass}`}>
      {MASKED_CELL_PLACEHOLDER}
    </td>
  );
};

export const renderUnloadedMonthCells = (
  month: string,
  currentMonth: string,
  cellClassName: string,
  plansMode: BudgetPlansMode,
  monthDividerClass: string,
): ReactElement => {
  if (!isSplitBudgetMonth(month, currentMonth, plansMode)) {
    return (
      <td key={month} className={`${cellClassName}${monthDividerClass} ${styles.monthLoading}`}>
        &hellip;
      </td>
    );
  }

  // Only the real current month carries the emphasis box.
  const planEmphasisClass = month === currentMonth ? ` ${styles.currentMonthPlan}` : "";
  const actualEmphasisClass = month === currentMonth ? ` ${styles.currentMonthActual}` : "";
  return (
    <Fragment key={month}>
      <td className={`${cellClassName}${monthDividerClass}${planEmphasisClass} ${styles.monthLoading}`}>
        &hellip;
      </td>
      <td className={`${cellClassName}${actualEmphasisClass} ${styles.monthLoading}`}>
        &hellip;
      </td>
    </Fragment>
  );
};

export const renderColumnCells = (params: RenderColumnCellsParams): ReactElement => {
  const {
    column,
    currentMonth,
    currentYear,
    plansMode,
    loadedFrom,
    loadedTo,
    isYearLoading,
    renderYearLoading,
    renderMonthLoading,
    renderPastYear,
    renderFutureYear,
    renderSplitYear,
    renderPastMonth,
    renderFutureMonth,
    renderSplitMonth,
  } = params;

  if (column.kind === "year-total") {
    if (isYearLoading) {
      return renderYearLoading(isSplitBudgetYear(column.year, currentYear, plansMode));
    }
    if (isSplitBudgetYear(column.year, currentYear, plansMode)) {
      return renderSplitYear();
    }
    if (column.year < currentYear) {
      return renderPastYear();
    }
    return renderFutureYear();
  }

  if (!isBudgetMonthLoaded(column.month, loadedFrom, loadedTo)) {
    return renderMonthLoading(column.month);
  }

  if (isSplitBudgetMonth(column.month, currentMonth, plansMode)) {
    return renderSplitMonth(column.month === currentMonth);
  }
  if (isPastMonth(column.month, currentMonth)) {
    return renderPastMonth();
  }
  return renderFutureMonth();
};
