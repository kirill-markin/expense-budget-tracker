"use client";

import { Fragment, type ReactElement } from "react";

import type { NumberFormat } from "@/lib/locale";
import type { BudgetBaseLocalAcknowledgementByCell } from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import {
  buildBudgetValueColumns,
  type CellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { BudgetAdjustmentRowsController } from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import { AddCategoryRow } from "./direction/AddCategoryRow";
import { CategoryRow } from "./direction/CategoryRow";
import { DirectionSubtotalRow } from "./direction/DirectionSubtotalRow";

export type BudgetDirectionSectionProps = Readonly<{
  block: DirectionBlock;
  /**
   * Every category of this direction, including the ones the grid hides. Only
   * the rendered rows are filtered; pickers must keep the full list.
   */
  directionCategories: ReadonlyArray<string>;
  effectiveAllowlist: ReadonlySet<string> | null;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  taintedDirectionMonths: ReadonlySet<string>;
  taintedCells: ReadonlySet<string>;
  numberFormat: NumberFormat;
  budgetAdjustments: BudgetAdjustmentRowsController;
  copyToClipboard: (value: string) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  onPlanSave: (
    month: string,
    direction: string,
    category: string,
    value: number,
  ) => void;
  onBaseMutationIssued: (
    month: string,
    direction: string,
    category: string,
  ) => number;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => number;
  onBaseAcknowledged: (
    month: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  onFillMonthsAcknowledged: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
  onAddCategory: (direction: string, category: string) => void;
}>;

export const BudgetDirectionSection = (props: BudgetDirectionSectionProps): ReactElement => {
  const {
    block,
    directionCategories,
    effectiveAllowlist,
    localBaseAcknowledgementByCell,
    columnSequence,
    currentMonth,
    currentYear,
    loadedFrom,
    loadedTo,
    yearComputed,
    filteredSubtotalsMap,
    taintedDirectionMonths,
    taintedCells,
    numberFormat,
    budgetAdjustments,
    copyToClipboard,
    openDrillDown,
    onPlanSave,
    onBaseMutationIssued,
    onFillMonths,
    onBaseAcknowledged,
    onFillMonthsAcknowledged,
    onSyncStart,
    onSyncEnd,
    onAddCategory,
  } = props;

  const useFilteredSubtotals = effectiveAllowlist !== null;
  const allowedCategoriesArray = effectiveAllowlist !== null ? [...effectiveAllowlist] : null;
  // Transfers carry no named categories, and in filtered mode a new name would
  // render as a masked, unusable row, so neither case offers the control.
  const canAddCategory = effectiveAllowlist === null
    && (block.direction === "income" || block.direction === "spend");

  return (
    <Fragment>
      <DirectionSubtotalRow
        block={block}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        loadedFrom={loadedFrom}
        loadedTo={loadedTo}
        yearComputed={yearComputed}
        filteredSubtotalsMap={filteredSubtotalsMap}
        taintedDirectionMonths={taintedDirectionMonths}
        numberFormat={numberFormat}
        useFilteredSubtotals={useFilteredSubtotals}
        allowedCategoriesArray={allowedCategoriesArray}
        openDrillDown={openDrillDown}
      />
      {block.categories
        .filter((category) => category !== "" || directionCategories.length > 1)
        .map((category) => (
          <CategoryRow
            key={category}
            block={block}
            directionCategories={directionCategories}
            category={category}
            effectiveAllowlist={effectiveAllowlist}
            localBaseAcknowledgementByCell={
              localBaseAcknowledgementByCell
            }
            columnSequence={columnSequence}
            currentMonth={currentMonth}
            currentYear={currentYear}
            loadedFrom={loadedFrom}
            loadedTo={loadedTo}
            yearComputed={yearComputed}
            taintedCells={taintedCells}
            numberFormat={numberFormat}
            budgetAdjustments={budgetAdjustments}
            copyToClipboard={copyToClipboard}
            openDrillDown={openDrillDown}
            onPlanSave={onPlanSave}
            onBaseMutationIssued={onBaseMutationIssued}
            onFillMonths={onFillMonths}
            onBaseAcknowledged={onBaseAcknowledged}
            onFillMonthsAcknowledged={onFillMonthsAcknowledged}
            onSyncStart={onSyncStart}
            onSyncEnd={onSyncEnd}
          />
        ))}
      {canAddCategory && (
        <AddCategoryRow
          direction={block.direction}
          valueColumnCount={buildBudgetValueColumns(columnSequence, currentMonth).length}
          onAddCategory={onAddCategory}
        />
      )}
    </Fragment>
  );
};
