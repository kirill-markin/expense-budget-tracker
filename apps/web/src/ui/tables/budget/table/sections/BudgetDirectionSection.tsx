"use client";

import { Fragment, type ReactElement } from "react";

import type { NumberFormat } from "@/lib/locale";
import {
  type CellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import { CategoryRow } from "./direction/CategoryRow";
import { DirectionSubtotalRow } from "./direction/DirectionSubtotalRow";

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
