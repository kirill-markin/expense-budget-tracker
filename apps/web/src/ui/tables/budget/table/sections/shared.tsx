import { Fragment, type ReactElement } from "react";

import type { NumberFormat } from "@/lib/locale";
import {
  isFutureMonth,
  isPastMonth,
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
  isYearLoading: boolean;
  renderYearLoading: (isCurrentYear: boolean) => ReactElement;
  renderPastYear: () => ReactElement;
  renderFutureYear: () => ReactElement;
  renderCurrentYear: () => ReactElement;
  renderPastMonth: () => ReactElement;
  renderFutureMonth: () => ReactElement;
  renderCurrentMonth: () => ReactElement;
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
  const subtotalClass = isSubtotal ? ` ${styles.cellSubtotal}` : "";
  const taintedClass = isTainted ? ` ${tableStateStyles.error}` : "";

  if (isPastMonth(month, currentMonth)) {
    const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";
    return (
      <td
        key={key}
        className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${clickableClass} ${actualValueClass}`}
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
        className={`${styles.cell}${subtotalClass}${maskClass}${taintedClass}${isPlanOver ? ` ${tableStateStyles.over}` : ""} ${plannedValueClass}`}
      >
        {formatter(planned, numberFormat)}
      </td>
    );
  }

  const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";
  return (
    <Fragment key={key}>
      <td
        className={`${styles.cell} ${styles.currentMonthPlan}${subtotalClass}${maskClass}${taintedClass}${isPlanOver ? ` ${tableStateStyles.over}` : ""} ${plannedValueClass}`}
      >
        {formatter(planned, numberFormat)}
      </td>
      <td
        className={`${styles.cell} ${styles.currentMonthActual}${subtotalClass}${maskClass}${taintedClass}${isActualOver ? ` ${tableStateStyles.over}` : ""}${clickableClass} ${actualValueClass}`}
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
