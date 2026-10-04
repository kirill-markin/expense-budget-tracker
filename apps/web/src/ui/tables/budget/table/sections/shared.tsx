import { Fragment, type ReactElement } from "react";

import { MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  isBudgetMonthLoaded,
  isPastMonth,
  isSplitBudgetMonth,
  isSplitBudgetYear,
  type BudgetPlansMode,
  type ColumnEntry,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
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

export type RenderValueCellsParams = Readonly<{
  key: string;
  month: string;
  currentMonth: string;
  plansMode: BudgetPlansMode;
  planned: number;
  actual: number;
  isTainted: boolean;
  isPlanOver: boolean;
  isActualOver: boolean;
  isSubtotal: boolean;
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

export const buildYearTotalStateClass = (isError: boolean, isOver: boolean): string => {
  const classNames: string[] = [];

  if (isError) {
    classNames.push(tableStateStyles.error);
  }

  if (isOver) {
    classNames.push(tableStateStyles.over);
  }

  if (classNames.length > 0) {
    classNames.push(styles.yearTotalDanger);
  }

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
    isTainted,
    isPlanOver,
    isActualOver,
    isSubtotal,
    maskClass,
    plannedValueClass,
    actualValueClass,
    numberFormat,
    formatter,
    onActualClick,
  } = params;
  const isMasked = maskClass.includes("data-masked");
  const subtotalClass = isSubtotal ? ` ${styles.cellSubtotal}` : "";
  const taintedClass = !isMasked && isTainted ? ` ${tableStateStyles.error}` : "";
  const visiblePlannedValueClass = isMasked ? "" : plannedValueClass;
  const visibleActualValueClass = isMasked ? "" : actualValueClass;
  const visibleActualClick = isMasked ? null : onActualClick;

  if (!isSplitBudgetMonth(month, currentMonth, plansMode)) {
    if (isPastMonth(month, currentMonth)) {
      const pastClickableClass = visibleActualClick !== null ? ` ${styles.cellClickable}` : "";
      return (
        <td
          key={key}
          className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${pastClickableClass} ${visibleActualValueClass}`}
          onClick={visibleActualClick ?? undefined}
        >
          {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(actual, numberFormat)}
        </td>
      );
    }

    return (
      <td
        key={key}
        className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${!isMasked && isPlanOver ? ` ${tableStateStyles.over}` : ""} ${visiblePlannedValueClass}`}
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
        className={`${styles.cell}${planEmphasisClass}${subtotalClass}${maskClass}${taintedClass}${!isMasked && isPlanOver ? ` ${tableStateStyles.over}` : ""} ${visiblePlannedValueClass}`}
      >
        {isMasked ? MASKED_CELL_PLACEHOLDER : formatter(planned, numberFormat)}
      </td>
      <td
        className={`${styles.cell}${actualEmphasisClass}${subtotalClass}${maskClass}${taintedClass}${!isMasked && isActualOver ? ` ${tableStateStyles.over}` : ""}${clickableClass} ${visibleActualValueClass}`}
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
): ReactElement => {
  if (!isSplitBudgetMonth(month, currentMonth, plansMode)) {
    return (
      <td key={month} className={`${cellClassName} ${styles.monthLoading}`}>
        &hellip;
      </td>
    );
  }

  // Only the real current month carries the emphasis box.
  const planEmphasisClass = month === currentMonth ? ` ${styles.currentMonthPlan}` : "";
  const actualEmphasisClass = month === currentMonth ? ` ${styles.currentMonthActual}` : "";
  return (
    <Fragment key={month}>
      <td className={`${cellClassName}${planEmphasisClass} ${styles.monthLoading}`}>
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
