"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { getCellVisibility, type CellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import { BudgetPlanCell } from "@/ui/tables/budget/BudgetPlanCell";
import {
  formatAmount,
  lookupCell,
  zeroCellValue,
  type CellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import {
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildYearTotalStateClass,
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  isDirectionActualOverPlanned,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderSubtotalYearLoadingCells,
  renderValueCells,
} from "./shared";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";

export type BudgetDirectionSectionProps = Readonly<{
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

type DirectionSubtotalRowProps = Readonly<{
  block: DirectionBlock;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  taintedDirectionMonths: ReadonlySet<string>;
  numberFormat: NumberFormat;
  useFilteredSubtotals: boolean;
  allowedCategoriesArray: ReadonlyArray<string> | null;
  openDrillDown: (filter: DrillDownFilter) => void;
}>;

type CategoryRowProps = Readonly<{
  block: DirectionBlock;
  category: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
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

const DirectionSubtotalRow = (props: DirectionSubtotalRowProps): ReactElement => {
  const {
    block,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    filteredSubtotalsMap,
    taintedDirectionMonths,
    numberFormat,
    useFilteredSubtotals,
    allowedCategoriesArray,
    openDrillDown,
  } = props;
  const { t } = useTranslation();
  const dirVis: CellVisibility = { showData: true, maskClass: "" };

  return (
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
          renderYearLoading: (isCurrentYearValue) =>
            renderSubtotalYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderSubtotalYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${yearTotalStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                onClick={dirVis.showData
                  ? () => openDrillDown(buildDirectionYearDrillDownFilter(column.year, block.direction, allowedCategoriesArray))
                  : undefined}
              >
                {formatAmount(yearSubtotal.actual, numberFormat)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderSubtotalYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${yearTotalStateClass}`}>
                {formatAmount(yearSubtotal.planned, numberFormat)}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderSubtotalYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearSubtotal.planned, yearSubtotal.actual);
            const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            const yearTotalActualStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), isActualOver);
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${yearTotalPlanStateClass}`}>
                  {formatAmount(yearSubtotal.planned, numberFormat)}
                </td>
                <td
                  className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${yearTotalActualStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={dirVis.showData
                    ? () => openDrillDown(buildDirectionYearDrillDownFilter(column.year, block.direction, allowedCategoriesArray))
                    : undefined}
                >
                  {formatAmount(yearSubtotal.actual, numberFormat)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderSubtotalYearLoadingCells("invalid", false);
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
              onActualClick: dirVis.showData
                ? () => openDrillDown(buildDirectionMonthDrillDownFilter(column.month, block.direction, allowedCategoriesArray))
                : null,
            });
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderSubtotalYearLoadingCells("invalid", false);
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
              return renderSubtotalYearLoadingCells("invalid", false);
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
              isActualOver: isDirectionActualOverPlanned(block.direction, subtotal.planned, subtotal.actual),
              isSubtotal: true,
              maskClass: dirVis.maskClass,
              numberFormat,
              formatter: formatAmount,
              onActualClick: dirVis.showData
                ? () => openDrillDown(buildDirectionMonthDrillDownFilter(column.month, block.direction, allowedCategoriesArray))
                : null,
            });
          },
        });
      })}
    </tr>
  );
};

const CategoryRow = (props: CategoryRowProps): ReactElement => {
  const {
    block,
    category,
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
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
          renderYearLoading: (isCurrentYearValue) =>
            renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                onClick={categoryVisibility.showData
                  ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                  : undefined}
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
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}`}>
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
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearCell.planned, yearCell.actual);
            const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            const yearTotalActualStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), isActualOver);
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalPlanStateClass}`}>
                  {formatAmount(yearCell.planned, numberFormat)}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalActualStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                    : undefined}
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
              ? ` ${tableStateStyles.error}`
              : "";
            return (
              <td
                key={column.month}
                className={`${styles.cell}${categoryVisibility.maskClass}${taintedClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                onClick={categoryVisibility.showData
                  ? () => openDrillDown(buildCategoryMonthDrillDownFilter(column.month, block.direction, category))
                  : undefined}
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
              ? ` ${tableStateStyles.error}`
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
              ? ` ${tableStateStyles.error}`
              : "";
            const isActualOver = isDirectionActualOverPlanned(block.direction, cell.planned, cell.actual);
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
                  className={`${styles.cell} ${styles.currentMonthActual}${categoryVisibility.maskClass}${taintedClass}${isActualOver ? ` ${tableStateStyles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryMonthDrillDownFilter(column.month, block.direction, category))
                    : undefined}
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

  const useFilteredSubtotals = effectiveAllowlist !== null;
  const allowedCategoriesArray = effectiveAllowlist !== null ? [...effectiveAllowlist] : null;

  return (
    <Fragment>
      <DirectionSubtotalRow
        block={block}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        yearComputed={yearComputed}
        filteredSubtotalsMap={filteredSubtotalsMap}
        taintedDirectionMonths={taintedDirectionMonths}
        numberFormat={numberFormat}
        useFilteredSubtotals={useFilteredSubtotals}
        allowedCategoriesArray={allowedCategoriesArray}
        openDrillDown={openDrillDown}
      />
      {block.categories
        .filter((category) => category !== "" || block.categories.length > 1)
        .map((category) => (
          <CategoryRow
            key={category}
            block={block}
            category={category}
            effectiveAllowlist={effectiveAllowlist}
            columnSequence={columnSequence}
            currentMonth={currentMonth}
            currentYear={currentYear}
            yearComputed={yearComputed}
            taintedCells={taintedCells}
            commentedCells={commentedCells}
            numberFormat={numberFormat}
            copyToClipboard={copyToClipboard}
            openDrillDown={openDrillDown}
            onPlanSave={onPlanSave}
            onFillMonths={onFillMonths}
            onCommentPresenceChange={onCommentPresenceChange}
            onSyncStart={onSyncStart}
            onSyncEnd={onSyncEnd}
          />
        ))}
    </Fragment>
  );
};
