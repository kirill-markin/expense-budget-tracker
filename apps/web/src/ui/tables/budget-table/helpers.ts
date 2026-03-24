import type { DrillDownFilter } from "@/ui/tables/DrillDownPanel";
import { monthToDateFrom, monthToDateTo } from "@/ui/tables/budgetTableLogic";

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
});

export const isDirectionActualOverPlanned = (
  direction: string,
  planned: number,
  actual: number,
): boolean =>
  direction === "spend" && planned > 0 && actual > planned;

export const isNegativeValueOver = (value: number): boolean => value < 0;
