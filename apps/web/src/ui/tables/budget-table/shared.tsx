import { Fragment, type ReactElement } from "react";

import type { NumberFormat } from "@/lib/locale";
import {
  isFutureMonth,
  isPastMonth,
  type ColumnEntry,
} from "./logic";
import styles from "./BudgetTable.module.css";
export {
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  isDirectionActualOverPlanned,
  isNegativeValueOver,
} from "./helpers";

export type RenderValueCellsParams = Readonly<{
  key: string;
  month: string;
  currentMonth: string;
  planned: number;
  actual: number;
  isTainted: boolean;
  isPlanOver: boolean;
  isActualOver: boolean;
  isSubtotal: boolean;
  maskClass: string;
  numberFormat: NumberFormat;
  formatter: (value: number, numberFormat: NumberFormat) => string;
  onActualClick: (() => void) | null;
}>;

export type RenderColumnCellsParams = Readonly<{
  column: ColumnEntry;
  currentMonth: string;
  currentYear: string;
  isYearLoading: boolean;
  renderYearLoading: (isCurrentYear: boolean) => ReactElement;
  renderPastYear: () => ReactElement;
  renderFutureYear: () => ReactElement;
  renderCurrentYear: () => ReactElement;
  renderPastMonth: () => ReactElement;
  renderFutureMonth: () => ReactElement;
  renderCurrentMonth: () => ReactElement;
}>;

export const renderValueCells = (params: RenderValueCellsParams): ReactElement => {
  const {
    key,
    month,
    currentMonth,
    planned,
    actual,
    isTainted,
    isPlanOver,
    isActualOver,
    isSubtotal,
    maskClass,
    numberFormat,
    formatter,
    onActualClick,
  } = params;
  const subtotalClass = isSubtotal ? ` ${styles.cellSubtotal}` : "";
  const taintedClass = isTainted ? ` ${styles.error}` : "";

  if (isPastMonth(month, currentMonth)) {
    const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";
    return (
      <td
        key={key}
        className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${clickableClass}`}
        onClick={onActualClick ?? undefined}
      >
        {formatter(actual, numberFormat)}
      </td>
    );
  }

  if (isFutureMonth(month, currentMonth)) {
    return (
      <td
        key={key}
        className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${isPlanOver ? ` ${styles.over}` : ""}`}
      >
        {formatter(planned, numberFormat)}
      </td>
    );
  }

  const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";
  return (
    <Fragment key={key}>
      <td
        className={`${styles.cell} ${styles.currentMonthPlan}${subtotalClass}${maskClass}${taintedClass}${isPlanOver ? ` ${styles.over}` : ""}`}
      >
        {formatter(planned, numberFormat)}
      </td>
      <td
        className={`${styles.cell} ${styles.currentMonthActual}${subtotalClass}${maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${clickableClass}`}
        onClick={onActualClick ?? undefined}
      >
        {formatter(actual, numberFormat)}
      </td>
    </Fragment>
  );
};

export const renderSubtotalYearLoadingCells = (year: string, isCurrentYear: boolean): ReactElement => {
  if (isCurrentYear) {
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

export const renderDerivedYearLoadingCells = (year: string, isCurrentYear: boolean): ReactElement => {
  if (isCurrentYear) {
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

export const renderColumnCells = (params: RenderColumnCellsParams): ReactElement => {
  const {
    column,
    currentMonth,
    currentYear,
    isYearLoading,
    renderYearLoading,
    renderPastYear,
    renderFutureYear,
    renderCurrentYear,
    renderPastMonth,
    renderFutureMonth,
    renderCurrentMonth,
  } = params;

  if (column.kind === "year-total") {
    if (isYearLoading) {
      return renderYearLoading(column.year === currentYear);
    }
    if (column.year < currentYear) {
      return renderPastYear();
    }
    if (column.year > currentYear) {
      return renderFutureYear();
    }
    return renderCurrentYear();
  }

  if (isPastMonth(column.month, currentMonth)) {
    return renderPastMonth();
  }
  if (isFutureMonth(column.month, currentMonth)) {
    return renderFutureMonth();
  }
  return renderCurrentMonth();
};
