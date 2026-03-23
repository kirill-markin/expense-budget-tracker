"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { NumberFormat } from "@/lib/locale";
import { getCellVisibility, type CellVisibility } from "@/lib/dataMask";
import type { DrillDownFilter } from "@/ui/tables/DrillDownPanel";
import { BudgetPlanCell } from "@/ui/tables/BudgetPlanCell";
import type {
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  DirectionBlock,
  YearTotalComputed,
} from "@/ui/tables/budgetTableLogic";
import {
  formatAmount,
  formatFxAmount,
  isFutureMonth,
  isPastMonth,
  lookupCell,
  monthToDateFrom,
  monthToDateTo,
  zeroCellValue,
} from "@/ui/tables/budgetTableLogic";
import styles from "@/ui/tables/BudgetTable.module.css";

type BudgetTableHeaderProps = Readonly<{
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  isLoadingLeft: boolean;
}>;

type BudgetDirectionSectionProps = Readonly<{
  block: DirectionBlock;
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  taintedDirectionMonths: ReadonlySet<string>;
  taintedCells: ReadonlySet<string>;
  commentedCells: ReadonlySet<string>;
  numberFormat: NumberFormat;
  copyToClipboard: (value: string) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  onPlanSave: (
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ) => void;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => void;
  onCommentPresenceChange: (
    month: string,
    direction: string,
    category: string,
    hasComment: boolean,
  ) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

type BudgetDerivedSectionProps = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  taintedMonths: ReadonlySet<string>;
  fxAdjustments: ReadonlyMap<string, number>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  hasLiquidityBreakdown: boolean;
  liquidityTiers: ReadonlyArray<string>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  numberFormat: NumberFormat;
  openFxBreakdown: (month: string) => void;
}>;

type RenderValueCellsParams = Readonly<{
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

type RenderColumnCellsParams = Readonly<{
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

const renderValueCells = (params: RenderValueCellsParams): ReactElement => {
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

const renderYearLoadingCells = (year: string, isCurrentYear: boolean): ReactElement => {
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

const renderDerivedYearLoadingCells = (year: string, isCurrentYear: boolean): ReactElement => {
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

const renderColumnCells = (params: RenderColumnCellsParams): ReactElement => {
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
    renderCurrentMonth: renderCurrentMonthCells,
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
  return renderCurrentMonthCells();
};

export const BudgetTableHeader = (props: BudgetTableHeaderProps): ReactElement => {
  const { columnSequence, currentMonth, currentYear, isLoadingLeft } = props;
  const { t } = useTranslation();

  return (
    <thead>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`}>{t("budget.category")}</th>
        <th className={styles.leftSpacer} rowSpan={2}>{isLoadingLeft ? t("common.loading") : ""}</th>
        {columnSequence.map((column) => {
          if (column.kind === "year-total") {
            return (
              <th
                key={`total-${column.year}`}
                className={`${styles.headCell} ${styles.yearTotal}`}
                colSpan={column.year === currentYear ? 2 : 1}
              >
                {t("budget.total")} {column.year}
              </th>
            );
          }

          return (
            <th
              key={column.month}
              className={`${styles.headCell}${column.month === currentMonth ? ` ${styles.currentMonth}` : ""}`}
              colSpan={column.month === currentMonth ? 2 : 1}
              data-month={column.month}
            >
              {column.month}
            </th>
          );
        })}
      </tr>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`} />
        {columnSequence.map((column) => {
          if (column.kind === "year-total") {
            if (column.year < currentYear) {
              return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>;
            }
            if (column.year > currentYear) {
              return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>;
            }
            return (
              <Fragment key={`total-${column.year}`}>
                <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>
                <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>
              </Fragment>
            );
          }

          if (isPastMonth(column.month, currentMonth)) {
            return <th key={column.month} className={styles.subHeadCell}>{t("budget.actual")}</th>;
          }
          if (isFutureMonth(column.month, currentMonth)) {
            return <th key={column.month} className={styles.subHeadCell}>{t("budget.plan")}</th>;
          }
          return (
            <Fragment key={column.month}>
              <th className={`${styles.subHeadCell} ${styles.currentMonthPlan}`}>{t("budget.plan")}</th>
              <th className={`${styles.subHeadCell} ${styles.currentMonthActual}`}>{t("budget.actual")}</th>
            </Fragment>
          );
        })}
      </tr>
    </thead>
  );
};

export const BudgetDirectionSection = (props: BudgetDirectionSectionProps): ReactElement => {
  const {
    block,
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    filteredSubtotalsMap,
    taintedDirectionMonths,
    taintedCells,
    commentedCells,
    numberFormat,
    copyToClipboard,
    openDrillDown,
    onPlanSave,
    onFillMonths,
    onCommentPresenceChange,
    onSyncStart,
    onSyncEnd,
  } = props;
  const { t } = useTranslation();

  const useFilteredSubtotals = effectiveAllowlist !== null;
  const allowedCategoriesArray: ReadonlyArray<string> | null =
    effectiveAllowlist !== null ? [...effectiveAllowlist] : null;
  const dirVis: CellVisibility = { showData: true, maskClass: "" };

  return (
    <Fragment>
      <tr className={styles.directionRow}>
        <td className={`${styles.directionLabel} ${styles.stickyCol}`}>
          {t(`budget.direction${block.direction.charAt(0).toUpperCase()}${block.direction.slice(1)}`)}
        </td>
        <td className={styles.leftSpacer} />
        {columnSequence.map((column) => {
          const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
          return renderColumnCells({
            column,
            currentMonth,
            currentYear,
            isYearLoading: column.kind === "year-total" && yearData === undefined,
            renderYearLoading: (isCurrentYear) => renderYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
            renderPastYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const yearSubtotal = useFilteredSubtotals
                ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
                : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
              const taintedClass = yearData.taintedDirections.has(block.direction) ? ` ${styles.error}` : "";
              return (
                <td
                  key={`total-${column.year}`}
                  className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={dirVis.showData ? () => openDrillDown({
                    dateFrom: `${column.year}-01-01`,
                    dateTo: `${column.year}-12-31`,
                    direction: block.direction,
                    category: null,
                    categories: allowedCategoriesArray,
                  }) : undefined}
                >
                  {formatAmount(yearSubtotal.actual, numberFormat)}
                </td>
              );
            },
            renderFutureYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const yearSubtotal = useFilteredSubtotals
                ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
                : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
              const taintedClass = yearData.taintedDirections.has(block.direction) ? ` ${styles.error}` : "";
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}`}>
                  {formatAmount(yearSubtotal.planned, numberFormat)}
                </td>
              );
            },
            renderCurrentYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
              }
              const yearSubtotal = useFilteredSubtotals
                ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
                : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
              const taintedClass = yearData.taintedDirections.has(block.direction) ? ` ${styles.error}` : "";
              const isActualOver =
                yearSubtotal.actual > yearSubtotal.planned &&
                yearSubtotal.planned > 0 &&
                block.direction === "spend";
              return (
                <Fragment key={`total-${column.year}`}>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}`}>
                    {formatAmount(yearSubtotal.planned, numberFormat)}
                  </td>
                  <td
                    className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                    onClick={dirVis.showData ? () => openDrillDown({
                      dateFrom: `${column.year}-01-01`,
                      dateTo: `${column.year}-12-31`,
                      direction: block.direction,
                      category: null,
                      categories: allowedCategoriesArray,
                    }) : undefined}
                  >
                    {formatAmount(yearSubtotal.actual, numberFormat)}
                  </td>
                </Fragment>
              );
            },
            renderPastMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const subtotal = (useFilteredSubtotals
                ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
                : block.subtotals.get(column.month)) ?? zeroCellValue;
              const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: subtotal.planned,
                actual: subtotal.actual,
                isTainted,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: dirVis.maskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: dirVis.showData ? () => openDrillDown({
                  dateFrom: monthToDateFrom(column.month),
                  dateTo: monthToDateTo(column.month),
                  direction: block.direction,
                  category: null,
                  categories: allowedCategoriesArray,
                }) : null,
              });
            },
            renderFutureMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const subtotal = (useFilteredSubtotals
                ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
                : block.subtotals.get(column.month)) ?? zeroCellValue;
              const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: subtotal.planned,
                actual: subtotal.actual,
                isTainted,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: dirVis.maskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
            renderCurrentMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const subtotal = (useFilteredSubtotals
                ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
                : block.subtotals.get(column.month)) ?? zeroCellValue;
              const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
              const isActualOver =
                subtotal.actual > subtotal.planned &&
                subtotal.planned > 0 &&
                block.direction === "spend";
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: subtotal.planned,
                actual: subtotal.actual,
                isTainted,
                isPlanOver: false,
                isActualOver,
                isSubtotal: true,
                maskClass: dirVis.maskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: dirVis.showData ? () => openDrillDown({
                  dateFrom: monthToDateFrom(column.month),
                  dateTo: monthToDateTo(column.month),
                  direction: block.direction,
                  category: null,
                  categories: allowedCategoriesArray,
                }) : null,
              });
            },
          });
        })}
      </tr>
      {block.categories
        .filter((category) => category !== "" || block.categories.length > 1)
        .map((category) => {
          const categoryVisibility = getCellVisibility(effectiveAllowlist, category);

          return (
            <tr key={category} className={styles.categoryRow}>
              <td
                className={`${styles.categoryLabel} ${styles.stickyCol} copyable-cell${categoryVisibility.maskClass}`}
                onClick={() => copyToClipboard(category)}
              >
                {category}
              </td>
              <td className={styles.leftSpacer} />
              {columnSequence.map((column) => {
                const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
                return renderColumnCells({
                  column,
                  currentMonth,
                  currentYear,
                  isYearLoading: column.kind === "year-total" && yearData === undefined,
                  renderYearLoading: (isCurrentYear) => renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
                  renderPastYear: () => {
                    if (column.kind !== "year-total" || yearData === undefined) {
                      return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
                    }
                    const yearCell =
                      yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
                    const taintedClass = yearData.taintedCategories.has(`${block.direction}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    return (
                      <td
                        key={`total-${column.year}`}
                        className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${taintedClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                        onClick={categoryVisibility.showData ? () => openDrillDown({
                          dateFrom: `${column.year}-01-01`,
                          dateTo: `${column.year}-12-31`,
                          direction: block.direction,
                          category,
                          categories: null,
                        }) : undefined}
                      >
                        {formatAmount(yearCell.actual, numberFormat)}
                      </td>
                    );
                  },
                  renderFutureYear: () => {
                    if (column.kind !== "year-total" || yearData === undefined) {
                      return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
                    }
                    const yearCell =
                      yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
                    const taintedClass = yearData.taintedCategories.has(`${block.direction}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    return (
                      <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${taintedClass}`}>
                        {formatAmount(yearCell.planned, numberFormat)}
                      </td>
                    );
                  },
                  renderCurrentYear: () => {
                    if (column.kind !== "year-total" || yearData === undefined) {
                      return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
                    }
                    const yearCell =
                      yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
                    const taintedClass = yearData.taintedCategories.has(`${block.direction}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    const isActualOver =
                      yearCell.actual > yearCell.planned &&
                      yearCell.planned > 0 &&
                      block.direction === "spend";
                    return (
                      <Fragment key={`total-${column.year}`}>
                        <td className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${taintedClass}`}>
                          {formatAmount(yearCell.planned, numberFormat)}
                        </td>
                        <td
                          className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                          onClick={categoryVisibility.showData ? () => openDrillDown({
                            dateFrom: `${column.year}-01-01`,
                            dateTo: `${column.year}-12-31`,
                            direction: block.direction,
                            category,
                            categories: null,
                          }) : undefined}
                        >
                          {formatAmount(yearCell.actual, numberFormat)}
                        </td>
                      </Fragment>
                    );
                  },
                  renderPastMonth: () => {
                    if (column.kind !== "month") {
                      return renderDerivedYearLoadingCells("invalid", false);
                    }
                    const cell = lookupCell(block.cells, column.month, category);
                    const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    return (
                      <td
                        key={column.month}
                        className={`${styles.cell}${categoryVisibility.maskClass}${taintedClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                        onClick={categoryVisibility.showData ? () => openDrillDown({
                          dateFrom: monthToDateFrom(column.month),
                          dateTo: monthToDateTo(column.month),
                          direction: block.direction,
                          category,
                          categories: null,
                        }) : undefined}
                      >
                        {formatAmount(cell.actual, numberFormat)}
                      </td>
                    );
                  },
                  renderFutureMonth: () => {
                    if (column.kind !== "month") {
                      return renderDerivedYearLoadingCells("invalid", false);
                    }
                    const cell = lookupCell(block.cells, column.month, category);
                    const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    return (
                      <BudgetPlanCell
                        key={`${column.month}-plan`}
                        month={column.month}
                        direction={block.direction}
                        category={category}
                        plannedBase={cell.plannedBase}
                        plannedModifier={cell.plannedModifier}
                        planned={cell.planned}
                        hasComment={commentedCells.has(`${column.month}::${block.direction}::${category}`)}
                        showData={categoryVisibility.showData}
                        maskClass={categoryVisibility.maskClass}
                        taintedClass={taintedClass}
                        isPlanOver={false}
                        cmClass=""
                        onPlanSave={onPlanSave}
                        onFillMonths={onFillMonths}
                        onCommentPresenceChange={onCommentPresenceChange}
                        onSyncStart={onSyncStart}
                        onSyncEnd={onSyncEnd}
                      />
                    );
                  },
                  renderCurrentMonth: () => {
                    if (column.kind !== "month") {
                      return renderDerivedYearLoadingCells("invalid", false);
                    }
                    const cell = lookupCell(block.cells, column.month, category);
                    const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
                      ? ` ${styles.error}`
                      : "";
                    const isActualOver =
                      cell.actual > cell.planned &&
                      cell.planned > 0 &&
                      block.direction === "spend";
                    return (
                      <Fragment key={column.month}>
                        <BudgetPlanCell
                          month={column.month}
                          direction={block.direction}
                          category={category}
                          plannedBase={cell.plannedBase}
                          plannedModifier={cell.plannedModifier}
                          planned={cell.planned}
                          hasComment={commentedCells.has(`${column.month}::${block.direction}::${category}`)}
                          showData={categoryVisibility.showData}
                          maskClass={categoryVisibility.maskClass}
                          taintedClass={taintedClass}
                          isPlanOver={false}
                          cmClass={` ${styles.currentMonthPlan}`}
                          onPlanSave={onPlanSave}
                          onFillMonths={onFillMonths}
                          onCommentPresenceChange={onCommentPresenceChange}
                          onSyncStart={onSyncStart}
                          onSyncEnd={onSyncEnd}
                        />
                        <td
                          className={`${styles.cell} ${styles.currentMonthActual}${categoryVisibility.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                          onClick={categoryVisibility.showData ? () => openDrillDown({
                            dateFrom: monthToDateFrom(column.month),
                            dateTo: monthToDateTo(column.month),
                            direction: block.direction,
                            category,
                            categories: null,
                          }) : undefined}
                        >
                          {formatAmount(cell.actual, numberFormat)}
                        </td>
                      </Fragment>
                    );
                  },
                });
              })}
            </tr>
          );
        })}
    </Fragment>
  );
};

export const BudgetDerivedSection = (props: BudgetDerivedSectionProps): ReactElement => {
  const {
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    incomeSubtotals,
    spendSubtotals,
    transferSubtotals,
    taintedMonths,
    fxAdjustments,
    cumulativeBalances,
    hasLiquidityBreakdown,
    liquidityTiers,
    mebByLiq,
    projectedLiqBalances,
    numberFormat,
    openFxBreakdown,
  } = props;
  const { t } = useTranslation();
  const derivedMaskClass = getCellVisibility(effectiveAllowlist, null).maskClass;

  return (
    <>
      <tr className={styles.directionRow}>
        <td className={`${styles.directionLabel} ${styles.stickyCol}`}>{t("budget.remainder")}</td>
        <td className={styles.leftSpacer} />
        {columnSequence.map((column) => {
          const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
          return renderColumnCells({
            column,
            currentMonth,
            currentYear,
            isYearLoading: column.kind === "year-total" && yearData === undefined,
            renderYearLoading: (isCurrentYear) => renderYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
            renderPastYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.remainder.actual < 0 ? ` ${styles.over}` : ""}`}>
                  {formatAmount(yearData.remainder.actual, numberFormat)}
                </td>
              );
            },
            renderFutureYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.remainder.planned < 0 ? ` ${styles.over}` : ""}`}>
                  {formatAmount(yearData.remainder.planned, numberFormat)}
                </td>
              );
            },
            renderCurrentYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
              }
              const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
              return (
                <Fragment key={`total-${column.year}`}>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.remainder.planned < 0 ? ` ${styles.over}` : ""}`}>
                    {formatAmount(yearData.remainder.planned, numberFormat)}
                  </td>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.remainder.actual < 0 ? ` ${styles.over}` : ""}`}>
                    {formatAmount(yearData.remainder.actual, numberFormat)}
                  </td>
                </Fragment>
              );
            },
            renderPastMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const income = incomeSubtotals?.get(column.month) ?? zeroCellValue;
              const spend = spendSubtotals?.get(column.month) ?? zeroCellValue;
              const transfer = transferSubtotals?.get(column.month) ?? zeroCellValue;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: income.planned - spend.planned + transfer.planned,
                actual: income.actual - spend.actual + transfer.actual,
                isTainted: taintedMonths.has(column.month),
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
            renderFutureMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const income = incomeSubtotals?.get(column.month) ?? zeroCellValue;
              const spend = spendSubtotals?.get(column.month) ?? zeroCellValue;
              const transfer = transferSubtotals?.get(column.month) ?? zeroCellValue;
              const remainderPlan = income.planned - spend.planned + transfer.planned;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: remainderPlan,
                actual: income.actual - spend.actual + transfer.actual,
                isTainted: taintedMonths.has(column.month),
                isPlanOver: remainderPlan < 0,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
            renderCurrentMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const income = incomeSubtotals?.get(column.month) ?? zeroCellValue;
              const spend = spendSubtotals?.get(column.month) ?? zeroCellValue;
              const transfer = transferSubtotals?.get(column.month) ?? zeroCellValue;
              const remainderPlan = income.planned - spend.planned + transfer.planned;
              const remainderActual = income.actual - spend.actual + transfer.actual;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: remainderPlan,
                actual: remainderActual,
                isTainted: taintedMonths.has(column.month),
                isPlanOver: remainderPlan < 0,
                isActualOver: remainderActual < 0,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
          });
        })}
      </tr>

      <tr className={styles.categoryRow}>
        <td className={`${styles.categoryLabel} ${styles.stickyCol}`}>{t("budget.fxAdjust")}</td>
        <td className={styles.leftSpacer} />
        {columnSequence.map((column) => {
          const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
          return renderColumnCells({
            column,
            currentMonth,
            currentYear,
            isYearLoading: column.kind === "year-total" && yearData === undefined,
            renderYearLoading: (isCurrentYear) => renderYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
            renderPastYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>
                  {formatFxAmount(yearData.yearFxAdjust, numberFormat)}
                </td>
              );
            },
            renderFutureYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              return <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />;
            },
            renderCurrentYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
              }
              return (
                <Fragment key={`total-${column.year}`}>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>
                    {formatFxAmount(yearData.yearFxAdjust, numberFormat)}
                  </td>
                </Fragment>
              );
            },
            renderPastMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const fx = fxAdjustments.get(column.month);
              const fxClickable = fx !== undefined;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: 0,
                actual: fx ?? 0,
                isTainted: false,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: `${derivedMaskClass}${fxClickable ? ` ${styles.cellClickable}` : ""}`,
                numberFormat,
                formatter: formatFxAmount,
                onActualClick: fxClickable ? () => openFxBreakdown(column.month) : null,
              });
            },
            renderFutureMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: 0,
                actual: 0,
                isTainted: false,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatFxAmount,
                onActualClick: null,
              });
            },
            renderCurrentMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const fx = fxAdjustments.get(column.month);
              const fxClickable = fx !== undefined;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: 0,
                actual: fx ?? 0,
                isTainted: false,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatFxAmount,
                onActualClick: fxClickable ? () => openFxBreakdown(column.month) : null,
              });
            },
          });
        })}
      </tr>

      <tr className={styles.directionRow}>
        <td className={`${styles.directionLabel} ${styles.stickyCol}`}>{t("budget.balance")}</td>
        <td className={styles.leftSpacer} />
        {columnSequence.map((column) => {
          const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
          return renderColumnCells({
            column,
            currentMonth,
            currentYear,
            isYearLoading: column.kind === "year-total" && yearData === undefined,
            renderYearLoading: (isCurrentYear) => renderYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
            renderPastYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.decemberBalance.actual < 0 ? ` ${styles.over}` : ""}`}>
                  {formatAmount(yearData.decemberBalance.actual, numberFormat)}
                </td>
              );
            },
            renderFutureYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
              }
              const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
              return (
                <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.decemberBalance.plan < 0 ? ` ${styles.over}` : ""}`}>
                  {formatAmount(yearData.decemberBalance.plan, numberFormat)}
                </td>
              );
            },
            renderCurrentYear: () => {
              if (column.kind !== "year-total" || yearData === undefined) {
                return renderYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
              }
              const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
              return (
                <Fragment key={`total-${column.year}`}>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.decemberBalance.plan < 0 ? ` ${styles.over}` : ""}`}>
                    {formatAmount(yearData.decemberBalance.plan, numberFormat)}
                  </td>
                  <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yearData.decemberBalance.actual < 0 ? ` ${styles.over}` : ""}`}>
                    {formatAmount(yearData.decemberBalance.actual, numberFormat)}
                  </td>
                </Fragment>
              );
            },
            renderPastMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const balance = cumulativeBalances.get(column.month)!;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: balance.plan,
                actual: balance.actual,
                isTainted: balance.isTainted,
                isPlanOver: false,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
            renderFutureMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const balance = cumulativeBalances.get(column.month)!;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: balance.plan,
                actual: balance.actual,
                isTainted: balance.isTainted,
                isPlanOver: balance.plan < 0,
                isActualOver: false,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
            renderCurrentMonth: () => {
              if (column.kind !== "month") {
                return renderYearLoadingCells("invalid", false);
              }
              const balance = cumulativeBalances.get(column.month)!;
              return renderValueCells({
                key: column.month,
                month: column.month,
                currentMonth,
                planned: balance.plan,
                actual: balance.actual,
                isTainted: balance.isTainted,
                isPlanOver: balance.plan < 0,
                isActualOver: balance.actual < 0,
                isSubtotal: true,
                maskClass: derivedMaskClass,
                numberFormat,
                formatter: formatAmount,
                onActualClick: null,
              });
            },
          });
        })}
      </tr>

      {hasLiquidityBreakdown && liquidityTiers.map((liquidity) => (
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
              renderYearLoading: (isCurrentYear) => renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYear),
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
      ))}
    </>
  );
};
