import { monthToDateFrom, monthToDateTo } from "@/ui/tables/budget/budgetTableLogic";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";

export const buildDirectionYearDrillDownFilter = (
  year: string,
  direction: string,
  categories: ReadonlyArray<string> | null,
): DrillDownFilter => ({
  dateFrom: `${year}-01-01`,
  dateTo: `${year}-12-31`,
  direction,
  category: null,
  categories,
  businessPersonalTransfers: false,
});

export const buildDirectionMonthDrillDownFilter = (
  month: string,
  direction: string,
  categories: ReadonlyArray<string> | null,
): DrillDownFilter => ({
  dateFrom: monthToDateFrom(month),
  dateTo: monthToDateTo(month),
  direction,
  category: null,
  categories,
  businessPersonalTransfers: false,
});

export const buildCategoryYearDrillDownFilter = (
  year: string,
  direction: string,
  category: string,
): DrillDownFilter => ({
  dateFrom: `${year}-01-01`,
  dateTo: `${year}-12-31`,
  direction,
  category,
  categories: null,
  businessPersonalTransfers: false,
});

export const buildCategoryMonthDrillDownFilter = (
  month: string,
  direction: string,
  category: string,
): DrillDownFilter => ({
  dateFrom: monthToDateFrom(month),
  dateTo: monthToDateTo(month),
  direction,
  category,
  categories: null,
  businessPersonalTransfers: false,
});

export const buildBusinessPersonalTransferYearDrillDownFilter = (
  year: string,
): DrillDownFilter => ({
  dateFrom: `${year}-01-01`,
  dateTo: `${year}-12-31`,
  direction: null,
  category: null,
  categories: null,
  businessPersonalTransfers: true,
});

export const buildBusinessPersonalTransferMonthDrillDownFilter = (
  month: string,
): DrillDownFilter => ({
  dateFrom: monthToDateFrom(month),
  dateTo: monthToDateTo(month),
  direction: null,
  category: null,
  categories: null,
  businessPersonalTransfers: true,
});

export const isDirectionActualOverPlanned = (
  direction: string,
  planned: number,
  actual: number,
): boolean =>
  direction === "spend" && planned > 0 && actual > planned;

export const isNegativeValueOver = (value: number): boolean => value < 0;
