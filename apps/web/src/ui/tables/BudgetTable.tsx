"use client";

import { Fragment, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { FieldHints } from "@/server/transactions/getTransactions";
import { getCellVisibility, type CellVisibility } from "@/lib/dataMask";
import { offsetMonth, getCurrentMonth, generateMonthRange, getYear, getYearMonths } from "@/lib/monthUtils";
import type { BudgetRow, ConversionWarning, CumulativeBefore, BudgetGridResult } from "@/server/budget/getBudgetGrid";
import { useCommentPresence } from "@/ui/hooks/useCommentPresence";
import { useCopyToast } from "@/ui/hooks/useCopyToast";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { DrillDownPanel, type DrillDownFilter } from "@/ui/tables/DrillDownPanel";
import { FxBreakdownPanel } from "@/ui/tables/FxBreakdownPanel";

const BATCH_SIZE = 6;
const SCROLL_THRESHOLD = 200;
const POPOVER_WIDTH = 240;

type Props = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  initialMonthFrom: string;
  initialMonthTo: string;
  reportingCurrency: string;
  hints: FieldHints;
}>;

type CellValue = Readonly<{
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  actual: number;
}>;

type DirectionBlock = Readonly<{
  direction: string;
  label: string;
  categories: ReadonlyArray<string>;
  cells: ReadonlyMap<string, CellValue>;
  subtotals: ReadonlyMap<string, CellValue>;
}>;

const DIRECTION_ORDER: ReadonlyArray<string> = ["income", "spend", "transfer"];

const DIRECTION_LABELS: Readonly<Record<string, string>> = {
  income: "Income",
  spend: "Spend",
  transfer: "Transfer",
};

const cellKey = (month: string, category: string): string => `${month}::${category}`;

const zeroCellValue: CellValue = { plannedBase: 0, plannedModifier: 0, planned: 0, actual: 0 };

const lookupCell = (cells: ReadonlyMap<string, CellValue>, month: string, category: string): CellValue => {
  return cells.get(cellKey(month, category)) ?? zeroCellValue;
};

const formatAmount = (value: number): string => {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return rounded.toLocaleString("en-US");
};

/**
 * Formats an FX adjustment for display.
 * Negates the internal value so that visually:
 *   positive display = book overestimated (FX loss, shown red)
 *   negative display = book underestimated (FX gain)
 * Always shows an explicit +/- prefix.
 */
const formatFxAmount = (value: number): string => {
  const display = Math.round(-value);
  if (display === 0) return "0";
  const prefix = display > 0 ? "+" : "";
  return prefix + display.toLocaleString("en-US");
};

/**
 * Groups budget rows into DirectionBlocks with per-month subtotals.
 * Categories are sorted by effective value for the current year (descending):
 * past months use actual, current and future months use planned.
 * When an allowlist is active, visible (allowed) categories
 * are sorted first, then masked ones — each group by effective value.
 */
const buildBlocks = (
  rows: ReadonlyArray<BudgetRow>,
  months: ReadonlyArray<string>,
  currentMonth: string,
  allowlist: ReadonlySet<string> | null,
): ReadonlyArray<DirectionBlock> => {
  const cellMap = new Map<string, Map<string, CellValue>>();
  const categorySet = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!cellMap.has(row.direction)) {
      cellMap.set(row.direction, new Map());
    }
    if (!categorySet.has(row.direction)) {
      categorySet.set(row.direction, new Set());
    }

    const dirCells = cellMap.get(row.direction)!;
    const key = cellKey(row.month, row.category);
    const existing = dirCells.get(key) ?? zeroCellValue;
    dirCells.set(key, {
      plannedBase: existing.plannedBase + row.plannedBase,
      plannedModifier: existing.plannedModifier + row.plannedModifier,
      planned: existing.planned + row.planned,
      actual: existing.actual + row.actual,
    });

    categorySet.get(row.direction)!.add(row.category);
  }

  const currentYear = getYear(currentMonth);
  const monthSet = new Set(months);
  const currentYearMonths = getYearMonths(currentYear).filter((m) => monthSet.has(m));

  return DIRECTION_ORDER
    .filter((dir) => categorySet.has(dir))
    .map((dir) => {
      const cells = cellMap.get(dir)!;
      const unsortedCategories = Array.from(categorySet.get(dir)!);
      const maskedCategories: ReadonlySet<string> = allowlist !== null
        ? new Set(unsortedCategories.filter((c) => !allowlist.has(c)))
        : new Set();
      const categories = sortCategoriesByEffectiveValue(unsortedCategories, cells, currentYearMonths, currentMonth, maskedCategories);

      const subtotals = new Map<string, CellValue>();
      for (const month of months) {
        let baseSum = 0;
        let modSum = 0;
        let plannedSum = 0;
        let actualSum = 0;
        for (const cat of categories) {
          const cell = lookupCell(cells, month, cat);
          baseSum += cell.plannedBase;
          modSum += cell.plannedModifier;
          plannedSum += cell.planned;
          actualSum += cell.actual;
        }
        subtotals.set(month, { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum });
      }

      return {
        direction: dir,
        label: DIRECTION_LABELS[dir] ?? dir,
        categories,
        cells,
        subtotals,
      };
    });
};

type ColumnEntry = Readonly<
  | { kind: "month"; month: string }
  | { kind: "year-total"; year: string }
>;

/**
 * Builds an ordered column sequence from a month range, inserting a
 * year-total entry after December of each calendar year present in the range.
 */
const buildColumnSequence = (months: ReadonlyArray<string>): ReadonlyArray<ColumnEntry> => {
  const result: Array<ColumnEntry> = [];
  for (const month of months) {
    result.push({ kind: "month", month });
    if (month.endsWith("-12")) {
      result.push({ kind: "year-total", year: getYear(month) });
    }
  }
  return result;
};

/**
 * Sums CellValues produced by a lookup function over a list of months.
 * Used for both per-category totals and direction subtotals.
 */
const sumCellValuesOverMonths = (
  monthsToSum: ReadonlyArray<string>,
  getValue: (month: string) => CellValue,
): CellValue => {
  let baseSum = 0;
  let modSum = 0;
  let plannedSum = 0;
  let actualSum = 0;
  for (const month of monthsToSum) {
    const cell = getValue(month);
    baseSum += cell.plannedBase;
    modSum += cell.plannedModifier;
    plannedSum += cell.planned;
    actualSum += cell.actual;
  }
  return { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum };
};

type CumulativeBalance = Readonly<{
  plan: number;
  actual: number;
  isTainted: boolean;
}>;

/**
 * Pre-computes cumulative balance for each month.
 * Used by the Balance row and year-total Balance cells (which show December's value).
 *
 * When monthEndBalances are available (mark-to-market portfolio values at month-end
 * exchange rates), they override the budget-computed cumulative for past/current months.
 * This anchors the Balance row to the real portfolio value instead of historical-rate
 * bookkeeping.
 *
 * Past months: both plan and actual use monthEndBalance (actual portfolio value).
 * Current month: actual uses monthEndBalance, plan uses planned delta from previous
 *   month's monthEndBalance.
 * Future months: plan column only, projected from the last known monthEndBalance.
 *
 * Falls back to budget-computed cumulative when monthEndBalances are empty.
 * Transfer actuals are always included (transfers have no planned values).
 */
const computeCumulativeBalances = (
  months: ReadonlyArray<string>,
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined,
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined,
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined,
  cumBefore: CumulativeBefore,
  taintedMonthSet: ReadonlySet<string>,
  currentMonth: string,
  monthEndBalances: Readonly<Record<string, number>>,
): ReadonlyMap<string, CumulativeBalance> => {
  const result = new Map<string, CumulativeBalance>();
  // cumBefore covers months strictly before the loaded range — always past, so use actual.
  const actualBefore = cumBefore.incomeActual - cumBefore.spendActual + cumBefore.transferActual;
  // If we have a month-end balance for the month before the range, use it as the
  // starting point. This anchors the cumulative to the real portfolio value.
  const monthBeforeRange = months.length > 0 ? offsetMonth(months[0], -1) : "";
  let cumulativePlan = monthBeforeRange in monthEndBalances ? monthEndBalances[monthBeforeRange] : actualBefore;
  let cumulativeActual = cumulativePlan;
  let taintedSoFar = false;
  for (const month of months) {
    const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
    const spd = spendSubtotals?.get(month) ?? zeroCellValue;
    const txf = transferSubtotals?.get(month) ?? zeroCellValue;
    if (month < currentMonth) {
      // Past month: use real portfolio value if available.
      if (month in monthEndBalances) {
        cumulativePlan = monthEndBalances[month];
        cumulativeActual = monthEndBalances[month];
      } else {
        const actualDelta = inc.actual - spd.actual + txf.actual;
        cumulativePlan += actualDelta;
        cumulativeActual += actualDelta;
      }
    } else if (month === currentMonth) {
      // Current month: actual uses real portfolio value, plan uses planned delta.
      cumulativePlan += inc.planned - spd.planned + txf.actual;
      if (month in monthEndBalances) {
        cumulativeActual = monthEndBalances[month];
      } else {
        cumulativeActual += inc.actual - spd.actual + txf.actual;
      }
    } else {
      // Future month: only plan column shown, use planned.
      // Transfers have no plan, so use actual (typically 0 for future).
      cumulativePlan += inc.planned - spd.planned + txf.actual;
      cumulativeActual += inc.planned - spd.planned + txf.actual;
    }
    if (taintedMonthSet.has(month)) taintedSoFar = true;
    result.set(month, { plan: cumulativePlan, actual: cumulativeActual, isTainted: taintedSoFar });
  }
  return result;
};

/**
 * Computes the per-month FX adjustment: the difference between the actual
 * portfolio value change and the budget-computed change for that month.
 *
 * fxAdjust(M) = monthEndBalance(M) - monthEndBalance(M-1) - budgetDelta(M)
 *
 * Only computed for past/current months where both month-end balances exist.
 * Returns undefined for months without data (future months, missing rates).
 */
const computeFxAdjustments = (
  months: ReadonlyArray<string>,
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined,
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined,
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined,
  monthEndBalances: Readonly<Record<string, number>>,
  currentMonth: string,
): ReadonlyMap<string, number> => {
  const result = new Map<string, number>();
  for (const month of months) {
    if (month > currentMonth) continue;
    if (!(month in monthEndBalances)) continue;
    const prevMonth = offsetMonth(month, -1);
    if (!(prevMonth in monthEndBalances)) continue;
    const inc = incomeSubtotals?.get(month) ?? zeroCellValue;
    const spd = spendSubtotals?.get(month) ?? zeroCellValue;
    const txf = transferSubtotals?.get(month) ?? zeroCellValue;
    const budgetDelta = inc.actual - spd.actual + txf.actual;
    result.set(month, monthEndBalances[month] - monthEndBalances[prevMonth] - budgetDelta);
  }
  return result;
};

/**
 * Computes subtotals for a direction block including only allowed categories.
 * Used in filtered mode to show partial but accurate direction subtotals.
 */
const computeAllowedSubtotals = (
  block: DirectionBlock,
  months: ReadonlyArray<string>,
  allowlist: ReadonlySet<string>,
): ReadonlyMap<string, CellValue> => {
  const result = new Map<string, CellValue>();
  const visibleCategories = block.categories.filter((c) => allowlist.has(c));
  for (const month of months) {
    let baseSum = 0;
    let modSum = 0;
    let plannedSum = 0;
    let actualSum = 0;
    for (const cat of visibleCategories) {
      const cell = lookupCell(block.cells, month, cat);
      baseSum += cell.plannedBase;
      modSum += cell.plannedModifier;
      plannedSum += cell.planned;
      actualSum += cell.actual;
    }
    result.set(month, { plannedBase: baseSum, plannedModifier: modSum, planned: plannedSum, actual: actualSum });
  }
  return result;
};

/**
 * Result of fetching a full year's budget data from the server.
 */
type YearFetchResult = Readonly<{ rows: ReadonlyArray<BudgetRow>; cumulativeBefore: CumulativeBefore; monthEndBalances: Readonly<Record<string, number>>; monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>> }>;

/**
 * Pre-computed yearly totals fetched from the server.
 * All fields are derived from the full 12-month year data (Jan-Dec),
 * independent of the horizontally-scrolled loaded range.
 */
type YearTotalComputed = Readonly<{
  directionCategoryTotals: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  directionSubtotals: ReadonlyMap<string, CellValue>;
  filteredSubtotals: ReadonlyMap<string, CellValue>;
  remainder: CellValue;
  /** Sum of per-month FX adjustments for all months in this year. */
  yearFxAdjust: number;
  decemberBalance: CumulativeBalance;
  /** December balance per liquidity tier, for year-total column. */
  decemberBalancesByLiquidity: Readonly<Record<string, number>>;
  taintedCategories: ReadonlySet<string>;
  taintedDirections: ReadonlySet<string>;
  anyTainted: boolean;
}>;

/**
 * Computes all yearly totals from a full year of BudgetRows fetched from the server.
 * Returns pre-aggregated data for every year-total cell in the table:
 * direction subtotals, per-category totals, remainder, cumulative balance at December,
 * and tainted status.
 */
const computeYearTotal = (
  rows: ReadonlyArray<BudgetRow>,
  cumulativeBefore: CumulativeBefore,
  monthEndBalances: Readonly<Record<string, number>>,
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>,
  year: string,
  currentMonth: string,
  allowlist: ReadonlySet<string> | null,
): YearTotalComputed => {
  const yearMonths = getYearMonths(year);
  const blocks = buildBlocks(rows, yearMonths, currentMonth, allowlist);

  const directionSubtotals = new Map<string, CellValue>();
  const directionCategoryTotals = new Map<string, ReadonlyMap<string, CellValue>>();

  for (const block of blocks) {
    directionSubtotals.set(
      block.direction,
      sumCellValuesOverMonths(yearMonths, (m) => block.subtotals.get(m) ?? zeroCellValue),
    );
    const catTotals = new Map<string, CellValue>();
    for (const cat of block.categories) {
      catTotals.set(cat, sumCellValuesOverMonths(yearMonths, (m) => lookupCell(block.cells, m, cat)));
    }
    directionCategoryTotals.set(block.direction, catTotals);
  }

  const filteredSubtotals = new Map<string, CellValue>();
  if (allowlist !== null) {
    for (const block of blocks) {
      const filtered = computeAllowedSubtotals(block, yearMonths, allowlist);
      filteredSubtotals.set(
        block.direction,
        sumCellValuesOverMonths(yearMonths, (m) => filtered.get(m) ?? zeroCellValue),
      );
    }
  }

  const incSub = directionSubtotals.get("income") ?? zeroCellValue;
  const spdSub = directionSubtotals.get("spend") ?? zeroCellValue;
  const txfSub = directionSubtotals.get("transfer") ?? zeroCellValue;
  const remainder: CellValue = {
    plannedBase: incSub.plannedBase - spdSub.plannedBase + txfSub.plannedBase,
    plannedModifier: incSub.plannedModifier - spdSub.plannedModifier + txfSub.plannedModifier,
    planned: incSub.planned - spdSub.planned + txfSub.planned,
    actual: incSub.actual - spdSub.actual + txfSub.actual,
  };

  const taintedCategories = new Set<string>();
  const taintedDirections = new Set<string>();
  const taintedMonthSet = new Set<string>();
  let anyTainted = false;
  for (const row of rows) {
    if (row.hasUnconvertible) {
      taintedCategories.add(`${row.direction}::${row.category}`);
      taintedDirections.add(row.direction);
      taintedMonthSet.add(row.month);
      anyTainted = true;
    }
  }

  const inc = blocks.find((b) => b.direction === "income")?.subtotals;
  const spd = blocks.find((b) => b.direction === "spend")?.subtotals;
  const txf = blocks.find((b) => b.direction === "transfer")?.subtotals;
  const cumBalances = computeCumulativeBalances(yearMonths, inc, spd, txf, cumulativeBefore, taintedMonthSet, currentMonth, monthEndBalances);
  const decemberBalance = cumBalances.get(`${year}-12`) ?? { plan: 0, actual: 0, isTainted: anyTainted };

  const yearFxMap = computeFxAdjustments(yearMonths, inc, spd, txf, monthEndBalances, currentMonth);
  let yearFxAdjust = 0;
  for (const val of yearFxMap.values()) {
    yearFxAdjust += val;
  }

  const decemberBalancesByLiquidity = monthEndBalancesByLiquidity[`${year}-12`] ?? {};

  return {
    directionCategoryTotals,
    directionSubtotals,
    filteredSubtotals,
    remainder,
    yearFxAdjust,
    decemberBalance,
    decemberBalancesByLiquidity,
    taintedCategories,
    taintedDirections,
    anyTainted,
  };
};

/**
 * Computes the "effective value" of a category for sorting.
 * Months before currentMonth use actual; currentMonth and future use planned.
 */
const computeEffectiveValue = (
  cells: ReadonlyMap<string, CellValue>,
  category: string,
  yearMonths: ReadonlyArray<string>,
  currentMonth: string,
): number => {
  let total = 0;
  for (const month of yearMonths) {
    const cell = lookupCell(cells, month, category);
    total += month < currentMonth ? cell.actual : cell.planned;
  }
  return total;
};

/**
 * Sorts categories by effective value for the current year, descending.
 * When maskedCategories is non-empty, visible categories come first,
 * then masked ones — each group sorted by effective value independently.
 * Stable sort preserves relative order for equal values.
 */
const sortCategoriesByEffectiveValue = (
  categories: ReadonlyArray<string>,
  cells: ReadonlyMap<string, CellValue>,
  currentYearMonths: ReadonlyArray<string>,
  currentMonth: string,
  maskedCategories: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const withValues = [...categories].map((category) => ({
    category,
    value: computeEffectiveValue(cells, category, currentYearMonths, currentMonth),
    isMasked: maskedCategories.has(category),
  }));
  withValues.sort((a, b) => {
    if (a.isMasked !== b.isMasked) return a.isMasked ? 1 : -1;
    return b.value - a.value;
  });
  return withValues.map((entry) => entry.category);
};

const fetchBudgetRange = async (monthFrom: string, monthTo: string, planFrom: string, actualTo: string): Promise<BudgetGridResult> => {
  const url = `/api/budget-grid?monthFrom=${encodeURIComponent(monthFrom)}&monthTo=${encodeURIComponent(monthTo)}&planFrom=${encodeURIComponent(planFrom)}&actualTo=${encodeURIComponent(actualTo)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Budget API error: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<BudgetGridResult>;
};

const postBudgetPlan = async (params: {
  month: string;
  direction: string;
  category: string;
  kind: "base" | "modifier";
  plannedValue: number;
}): Promise<void> => {
  const response = await fetch("/api/budget-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan update failed: ${response.status} ${await response.text()}`);
  }
};

const postBudgetPlanFill = async (params: {
  fromMonth: string;
  direction: string;
  category: string;
  baseValue: number;
}): Promise<void> => {
  const response = await fetch("/api/budget-plan-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan fill failed: ${response.status} ${await response.text()}`);
  }
};

const fetchComment = async (month: string, direction: string, category: string): Promise<string | null> => {
  const params = new URLSearchParams({ month, direction, category });
  const response = await fetch(`/api/budget-comment?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Comment fetch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { comment: string | null };
  return data.comment;
};

const postComment = async (params: {
  month: string;
  direction: string;
  category: string;
  comment: string;
}): Promise<void> => {
  const response = await fetch("/api/budget-comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Comment save failed: ${response.status} ${await response.text()}`);
  }
};

const isPastMonth = (month: string, currentMonth: string): boolean => month < currentMonth;
const isFutureMonth = (month: string, currentMonth: string): boolean => month > currentMonth;

const isDecember = (month: string): boolean => month.endsWith("-12");

const monthToDateFrom = (month: string): string => `${month}-01`;

const monthToDateTo = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
};

const getTargetFillMonths = (sourceMonth: string): ReadonlyArray<string> => {
  const year = sourceMonth.substring(0, 4);
  const monthNum = parseInt(sourceMonth.substring(5, 7), 10);
  const result: Array<string> = [];
  for (let m = monthNum + 1; m <= 12; m++) {
    result.push(`${year}-${String(m).padStart(2, "0")}`);
  }
  return result;
};

type BudgetPlanCellProps = Readonly<{
  month: string;
  direction: string;
  category: string;
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  hasComment: boolean;
  showData: boolean;
  maskClass: string;
  taintedClass: string;
  isPlanOver: boolean;
  cmClass: string;
  onPlanSave: (month: string, direction: string, category: string, kind: "base" | "modifier", value: number) => void;
  onFillMonths: (sourceMonth: string, direction: string, category: string, baseValue: number) => void;
  onCommentPresenceChange: (month: string, direction: string, category: string, hasComment: boolean) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

const BudgetPlanCell = (props: BudgetPlanCellProps): ReactElement => {
  const { month, direction, category, plannedBase, plannedModifier, planned, hasComment, showData, maskClass, taintedClass, isPlanOver, cmClass, onPlanSave, onFillMonths, onCommentPresenceChange, onSyncStart, onSyncEnd } = props;

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const [modifierInput, setModifierInput] = useState<string>("");
  const [commentInput, setCommentInput] = useState<string>("");
  const [isLoadingComment, setIsLoadingComment] = useState<boolean>(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const cellRef = useRef<HTMLTableCellElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const adjustInputRef = useRef<HTMLInputElement>(null);

  const originalBase = useRef<number>(0);
  const originalModifier = useRef<number>(0);
  const originalComment = useRef<string>("");

  const openPopover = (): void => {
    if (!showData) return;
    const roundedBase = Math.round(plannedBase);
    const roundedModifier = Math.round(plannedModifier);
    setBaseInput(String(roundedBase));
    setModifierInput(String(roundedModifier));
    originalBase.current = roundedBase;
    originalModifier.current = roundedModifier;

    const rect = cellRef.current?.getBoundingClientRect();
    if (rect !== undefined && rect !== null) {
      let left = rect.right - POPOVER_WIDTH;
      if (left < 0) left = rect.left;
      setPopoverPos({ top: rect.bottom + 4, left });
    }
    setIsOpen(true);

    setIsLoadingComment(true);
    setCommentInput("");
    originalComment.current = "";
    fetchComment(month, direction, category)
      .then((c) => {
        const val = c ?? "";
        setCommentInput(val);
        originalComment.current = val;
      })
      .catch((error) => console.error(error))
      .finally(() => setIsLoadingComment(false));
  };

  useEffect(() => {
    if (isOpen && adjustInputRef.current !== null) {
      adjustInputRef.current.focus();
      adjustInputRef.current.select();
    }
  }, [isOpen]);

  const saveChanges = useCallback((): void => {
    const newBase = Math.round(Number(baseInput));
    const newMod = Math.round(Number(modifierInput));

    const baseChanged = Number.isFinite(newBase) && newBase !== originalBase.current;
    const modChanged = Number.isFinite(newMod) && newMod !== originalModifier.current;

    if (baseChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", newBase);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: newBase })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    if (modChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", newMod);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: newMod })
        .catch((error) => {
          onPlanSave(month, direction, category, "modifier", originalModifier.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    if (commentInput !== originalComment.current) {
      onSyncStart();
      onCommentPresenceChange(month, direction, category, commentInput.trim().length > 0);
      postComment({ month, direction, category, comment: commentInput })
        .catch((error) => console.error(error))
        .finally(onSyncEnd);
    }
  }, [baseInput, modifierInput, commentInput, month, direction, category, onPlanSave, onCommentPresenceChange, onSyncStart, onSyncEnd]);

  const closePopover = useCallback((): void => {
    if (!isOpen) return;
    saveChanges();
    setIsOpen(false);
  }, [isOpen, saveChanges]);

  const handleFill = useCallback((): void => {
    const newBase = Math.round(Number(baseInput));
    if (!Number.isFinite(newBase)) return;

    // Save base for current month if changed
    if (newBase !== originalBase.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", newBase);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: newBase })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Save modifier for current month if changed
    const newMod = Math.round(Number(modifierInput));
    if (Number.isFinite(newMod) && newMod !== originalModifier.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", newMod);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: newMod })
        .catch((error) => {
          onPlanSave(month, direction, category, "modifier", originalModifier.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Fill base to following months
    onSyncStart();
    onFillMonths(month, direction, category, newBase);
    postBudgetPlanFill({ fromMonth: month, direction, category, baseValue: newBase })
      .catch((error) => {
        console.error(error);
      })
      .finally(onSyncEnd);

    setIsOpen(false);
  }, [baseInput, modifierInput, month, direction, category, onPlanSave, onFillMonths, onSyncStart, onSyncEnd]);

  // Click outside → close
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        popoverRef.current !== null && !popoverRef.current.contains(target) &&
        cellRef.current !== null && !cellRef.current.contains(target)
      ) {
        closePopover();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, closePopover]);

  // Escape → close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setIsOpen(false); // close without saving
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleBaseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const handleModifierKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const computedTotal = Math.round(Number(baseInput) || 0) + Math.round(Number(modifierInput) || 0);
  const canFill = !isDecember(month);

  const modifierIconClass = direction === "income"
    ? (plannedModifier > 0 ? "budget-icon-good" : "budget-icon-bad")
    : (plannedModifier > 0 ? "budget-icon-bad-up" : "budget-icon-good-down");

  return (
    <td
      ref={cellRef}
      className={`budget-cell budget-cell-editable${cmClass}${maskClass}${taintedClass}${isPlanOver ? " budget-over" : ""}`}
      onClick={isOpen ? undefined : openPopover}
    >
      {showData && plannedModifier !== 0 && (
        <span className={`budget-icon-modifier ${modifierIconClass}`} />
      )}
      {formatAmount(planned)}
      {isOpen && createPortal(
        <div
          ref={popoverRef}
          className="budget-popover"
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <label className="budget-popover-field">
            <span className="budget-popover-label">Adjust</span>
            <input
              ref={adjustInputRef}
              type="number"
              className="budget-popover-input"
              value={modifierInput}
              onChange={(e) => setModifierInput(e.target.value)}
              onKeyDown={handleModifierKeyDown}
            />
          </label>
          <label className="budget-popover-field">
            <span className="budget-popover-label">Base</span>
            <input
              type="number"
              className="budget-popover-input"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              onKeyDown={handleBaseKeyDown}
            />
          </label>
          <div className="budget-popover-divider" />
          <div className="budget-popover-total">
            <span className="budget-popover-label">Total</span>
            <span className="budget-popover-total-value">{formatAmount(computedTotal)}</span>
          </div>
          {canFill && (
            <>
              <div className="budget-popover-divider" />
              <button
                type="button"
                className="budget-popover-fill-btn"
                onClick={handleFill}
              >
                Fill months &rarr;
              </button>
            </>
          )}
          <div className="budget-popover-divider" />
          {isLoadingComment
            ? <span className="budget-popover-loading">Loading&hellip;</span>
            : (
              <textarea
                className="budget-popover-comment"
                rows={2}
                placeholder="Note"
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
              />
            )
          }
        </div>,
        document.body,
      )}
    </td>
  );
};

export const BudgetTable = (props: Props): ReactElement => {
  const { conversionWarnings, initialMonthFrom, initialMonthTo, reportingCurrency, hints } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const { commentedCells, fetchRange: fetchCommentRange, updateCell: updateCommentCell } = useCommentPresence(initialMonthFrom, initialMonthTo);
  const { toastMessage, copyToClipboard } = useCopyToast();

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const currentYear = useMemo(() => getYear(currentMonth), [currentMonth]);

  const [allRows, setAllRows] = useState<ReadonlyArray<BudgetRow>>(props.rows);
  const [loadedFrom, setLoadedFrom] = useState<string>(initialMonthFrom);
  const [loadedTo, setLoadedTo] = useState<string>(initialMonthTo);
  const [cumBefore, setCumBefore] = useState<CumulativeBefore>(props.cumulativeBefore);
  const [meb, setMeb] = useState<Readonly<Record<string, number>>>(props.monthEndBalances);
  const [mebByLiq, setMebByLiq] = useState<Readonly<Record<string, Readonly<Record<string, number>>>>>(props.monthEndBalancesByLiquidity);
  const [isLoadingLeft, setIsLoadingLeft] = useState<boolean>(false);
  const [isLoadingRight, setIsLoadingRight] = useState<boolean>(false);
  const [pendingSaves, setPendingSaves] = useState<number>(0);
  const [drillDownFilter, setDrillDownFilter] = useState<DrillDownFilter | null>(null);
  const [fxBreakdownMonth, setFxBreakdownMonth] = useState<string | null>(null);

  const onSyncStart = useCallback((): void => setPendingSaves((n) => n + 1), []);
  const onSyncEnd = useCallback((): void => setPendingSaves((n) => Math.max(0, n - 1)), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollWidthRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  const isLoadingLeftRef = useRef<boolean>(false);
  const isLoadingRightRef = useRef<boolean>(false);

  const months = useMemo<ReadonlyArray<string>>(
    () => generateMonthRange(loadedFrom, loadedTo),
    [loadedFrom, loadedTo],
  );

  const blocks = useMemo(() => buildBlocks(allRows, months, currentMonth, effectiveAllowlist), [allRows, months, currentMonth, effectiveAllowlist]);

  const columnSequence = useMemo<ReadonlyArray<ColumnEntry>>(
    () => buildColumnSequence(months),
    [months],
  );

  const allCategories = useMemo<ReadonlyArray<string>>(() => {
    const set = new Set<string>();
    for (const block of blocks) {
      for (const cat of block.categories) set.add(cat);
    }
    return [...set].sort();
  }, [blocks]);

  const filteredSubtotalsMap = useMemo<ReadonlyMap<string, ReadonlyMap<string, CellValue>>>(() => {
    if (effectiveAllowlist === null) return new Map();
    const result = new Map<string, ReadonlyMap<string, CellValue>>();
    for (const block of blocks) {
      result.set(block.direction, computeAllowedSubtotals(block, months, effectiveAllowlist));
    }
    return result;
  }, [blocks, months, effectiveAllowlist]);

  const incomeSubtotals = blocks.find((b) => b.direction === "income")?.subtotals;
  const spendSubtotals = blocks.find((b) => b.direction === "spend")?.subtotals;
  const transferSubtotals = blocks.find((b) => b.direction === "transfer")?.subtotals;

  const taintedCells = useMemo(() => {
    const set = new Set<string>();
    for (const row of allRows) {
      if (row.hasUnconvertible) {
        set.add(`${row.direction}::${row.month}::${row.category}`);
      }
    }
    return set;
  }, [allRows]);

  const taintedDirectionMonths = useMemo(() => {
    const set = new Set<string>();
    for (const key of taintedCells) {
      const parts = key.split("::");
      set.add(`${parts[0]}::${parts[1]}`);
    }
    return set;
  }, [taintedCells]);

  const taintedMonths = useMemo(() => {
    const set = new Set<string>();
    for (const key of taintedCells) {
      set.add(key.split("::")[1]);
    }
    return set;
  }, [taintedCells]);

  const cumulativeBalances = useMemo<ReadonlyMap<string, CumulativeBalance>>(
    () => computeCumulativeBalances(months, incomeSubtotals, spendSubtotals, transferSubtotals, cumBefore, taintedMonths, currentMonth, meb),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, cumBefore, taintedMonths, currentMonth, meb],
  );

  const fxAdjustments = useMemo<ReadonlyMap<string, number>>(
    () => computeFxAdjustments(months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth],
  );

  const LIQUIDITY_ORDER: ReadonlyArray<string> = ["high", "medium", "low"];
  const LIQUIDITY_LABELS: Readonly<Record<string, string>> = { high: "Balance (high)", medium: "Balance (medium)", low: "Balance (low)" };

  const liquidityTiers = useMemo<ReadonlyArray<string>>(() => {
    const tiers = new Set<string>();
    for (const liqMap of Object.values(mebByLiq)) {
      for (const [liq, val] of Object.entries(liqMap)) {
        if (val !== 0) tiers.add(liq);
      }
    }
    return LIQUIDITY_ORDER.filter((l) => tiers.has(l));
  }, [mebByLiq]);

  const hasLiquidityBreakdown = useMemo<boolean>(
    () => liquidityTiers.length > 1 || (liquidityTiers.length === 1 && liquidityTiers[0] !== "high"),
    [liquidityTiers],
  );

  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
  const yearFetchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const col of columnSequence) {
      if (col.kind !== "year-total") continue;
      const { year } = col;
      if (yearFetchResults.has(year) || yearFetchingRef.current.has(year)) continue;

      yearFetchingRef.current.add(year);
      fetchBudgetRange(`${year}-01`, `${year}-12`, `${year}-01`, currentMonth)
        .then((result) => {
          setYearFetchResults((prev) => new Map([...prev, [year, { rows: result.rows, cumulativeBefore: result.cumulativeBefore, monthEndBalances: result.monthEndBalances, monthEndBalancesByLiquidity: result.monthEndBalancesByLiquidity }]]));
        })
        .catch((error) => console.error(error))
        .finally(() => {
          yearFetchingRef.current.delete(year);
        });
    }
  }, [columnSequence, yearFetchResults]);

  const yearComputed = useMemo<ReadonlyMap<string, YearTotalComputed>>(() => {
    const result = new Map<string, YearTotalComputed>();
    for (const [year, data] of yearFetchResults) {
      result.set(year, computeYearTotal(data.rows, data.cumulativeBefore, data.monthEndBalances, data.monthEndBalancesByLiquidity, year, currentMonth, effectiveAllowlist));
    }
    return result;
  }, [yearFetchResults, currentMonth, effectiveAllowlist]);

  const handlePlanSave = useCallback((month: string, direction: string, category: string, kind: "base" | "modifier", value: number): void => {
    setAllRows((prev) => {
      const idx = prev.findIndex((r) => r.month === month && r.direction === direction && r.category === category);
      if (idx >= 0) {
        const row = prev[idx];
        const newBase = kind === "base" ? value : row.plannedBase;
        const newModifier = kind === "modifier" ? value : row.plannedModifier;
        const updated: BudgetRow = { ...row, plannedBase: newBase, plannedModifier: newModifier, planned: newBase + newModifier };
        return [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)];
      }
      const newBase = kind === "base" ? value : 0;
      const newModifier = kind === "modifier" ? value : 0;
      return [...prev, { month, direction, category, plannedBase: newBase, plannedModifier: newModifier, planned: newBase + newModifier, actual: 0, hasUnconvertible: false }];
    });
  }, []);

  const handleFillMonths = useCallback((sourceMonth: string, direction: string, category: string, baseValue: number): void => {
    const targetMonths = getTargetFillMonths(sourceMonth);
    setAllRows((prev) => {
      const updated = [...prev];
      for (const tm of targetMonths) {
        const idx = updated.findIndex((r) => r.month === tm && r.direction === direction && r.category === category);
        if (idx >= 0) {
          const row = updated[idx];
          updated[idx] = { ...row, plannedBase: baseValue, planned: baseValue + row.plannedModifier };
        } else {
          updated.push({ month: tm, direction, category, plannedBase: baseValue, plannedModifier: 0, planned: baseValue, actual: 0, hasUnconvertible: false });
        }
      }
      return updated;
    });
  }, []);

  const handleDrillDownClose = useCallback((dirty: boolean): void => {
    setDrillDownFilter(null);
    if (!dirty) return;

    fetchBudgetRange(loadedFrom, loadedTo, currentMonth, currentMonth)
      .then((result) => {
        setAllRows(result.rows);
        setCumBefore(result.cumulativeBefore);
        setMeb(result.monthEndBalances);
        setMebByLiq(result.monthEndBalancesByLiquidity);
      })
      .catch((error) => console.error(error));

    setYearFetchResults(new Map());
    yearFetchingRef.current.clear();
  }, [loadedFrom, loadedTo]);

  const loadLeft = useCallback(async () => {
    if (isLoadingLeftRef.current) return;
    isLoadingLeftRef.current = true;
    setIsLoadingLeft(true);

    const newTo = offsetMonth(loadedFrom, -1);
    const newFrom = offsetMonth(loadedFrom, -BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth);
      const newRows = result.rows;

      const el = scrollRef.current;
      if (el !== null) {
        prevScrollWidthRef.current = el.scrollWidth;
        isPrependingRef.current = true;
      }

      setAllRows((prev) => [...newRows, ...prev]);
      // Derive cumBefore locally: old cumBefore minus the new rows' actuals.
      // This guarantees consistency with the row data (avoids SQL rounding drift).
      setCumBefore((prev) => {
        let incDelta = 0;
        let spdDelta = 0;
        let txfDelta = 0;
        for (const row of newRows) {
          if (row.direction === "income") incDelta += row.actual;
          else if (row.direction === "spend") spdDelta += row.actual;
          else if (row.direction === "transfer") txfDelta += row.actual;
        }
        return {
          incomeActual: prev.incomeActual - incDelta,
          spendActual: prev.spendActual - spdDelta,
          transferActual: prev.transferActual - txfDelta,
        };
      });
      setLoadedFrom(newFrom);
      setMeb((prev) => ({ ...prev, ...result.monthEndBalances }));
      setMebByLiq((prev) => ({ ...prev, ...result.monthEndBalancesByLiquidity }));
      fetchCommentRange(newFrom, newTo);
    } finally {
      isLoadingLeftRef.current = false;
      setIsLoadingLeft(false);
    }
  }, [loadedFrom, fetchCommentRange]);

  const loadRight = useCallback(async () => {
    if (isLoadingRightRef.current) return;
    isLoadingRightRef.current = true;
    setIsLoadingRight(true);

    const newFrom = offsetMonth(loadedTo, 1);
    const newTo = offsetMonth(loadedTo, BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth);
      setAllRows((prev) => [...prev, ...result.rows]);
      setLoadedTo(newTo);
      setMeb((prev) => ({ ...prev, ...result.monthEndBalances }));
      setMebByLiq((prev) => ({ ...prev, ...result.monthEndBalancesByLiquidity }));
      fetchCommentRange(newFrom, newTo);
    } finally {
      isLoadingRightRef.current = false;
      setIsLoadingRight(false);
    }
  }, [loadedTo, fetchCommentRange]);

  useLayoutEffect(() => {
    if (!isPrependingRef.current) return;
    isPrependingRef.current = false;

    const el = scrollRef.current;
    if (el === null) return;

    const delta = el.scrollWidth - prevScrollWidthRef.current;
    el.scrollLeft += delta;
  });

  const scrollToCurrentMonth = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;

    const monthEl = el.querySelector<HTMLElement>(`[data-month="${currentMonth}"]`);
    if (monthEl === null) return;

    const containerRect = el.getBoundingClientRect();
    const monthRect = monthEl.getBoundingClientRect();
    const stickyCol = el.querySelector<HTMLElement>(".budget-sticky-col");
    const stickyWidth = stickyCol !== null ? stickyCol.offsetWidth : 0;

    el.scrollLeft += monthRect.left - containerRect.left - stickyWidth;
  }, [currentMonth]);

  useLayoutEffect(() => {
    scrollToCurrentMonth();
  }, [scrollToCurrentMonth]);

  useEffect(() => {
    if (pendingSaves === 0) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pendingSaves]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;

    let rafId: number = 0;

    const handleScroll = (): void => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (el.scrollLeft < SCROLL_THRESHOLD) {
          void loadLeft();
        }
        if (el.scrollWidth - el.scrollLeft - el.clientWidth < SCROLL_THRESHOLD) {
          void loadRight();
        }
      });
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [loadLeft, loadRight]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const thead = el.querySelector<HTMLElement>("thead");
    if (thead === null) return;

    let startX = 0;
    let startScrollLeft = 0;

    const onMouseMove = (e: MouseEvent): void => {
      el.scrollLeft = startScrollLeft - (e.pageX - startX);
    };

    const onMouseUp = (): void => {
      el.classList.remove("budget-dragging");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault();
      startX = e.pageX;
      startScrollLeft = el.scrollLeft;
      el.classList.add("budget-dragging");
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    thead.addEventListener("mousedown", onMouseDown);
    return () => {
      thead.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  if (months.length === 0) {
    return <p className="budget-empty">No budget data yet.</p>;
  }

  const currencyList = conversionWarnings.map((w) => w.currency).join(", ");

  const renderMonthCells = (
    month: string,
    planned: number,
    actual: number,
    isTainted: boolean,
    isPlanOver: boolean,
    isActualOver: boolean,
    isSubtotal: boolean,
    localMaskClass: string,
    onActualClick: (() => void) | null,
  ): ReactElement => {
    const subtotalClass = isSubtotal ? " budget-cell-subtotal" : "";
    const taintedClass = isTainted ? " budget-error" : "";
    if (isPastMonth(month, currentMonth)) {
      const clickableClass = onActualClick !== null ? " budget-cell-clickable" : "";
      return (
        <td
          className={`budget-cell${subtotalClass}${localMaskClass}${taintedClass}${clickableClass}`}
          onClick={onActualClick ?? undefined}
        >
          {formatAmount(actual)}
        </td>
      );
    }

    if (isFutureMonth(month, currentMonth)) {
      return (
        <td className={`budget-cell${subtotalClass}${localMaskClass}${taintedClass}${isPlanOver ? " budget-over" : ""}`}>
          {formatAmount(planned)}
        </td>
      );
    }

    const clickableClass = onActualClick !== null ? " budget-cell-clickable" : "";

    return (
      <Fragment>
        <td className={`budget-cell budget-cm-plan${subtotalClass}${localMaskClass}${taintedClass}${isPlanOver ? " budget-over" : ""}`}>
          {formatAmount(planned)}
        </td>
        <td
          className={`budget-cell budget-cm-actual${subtotalClass}${localMaskClass}${taintedClass}${isActualOver ? " budget-over" : ""}${clickableClass}`}
          onClick={onActualClick ?? undefined}
        >
          {formatAmount(actual)}
        </td>
      </Fragment>
    );
  };

  return (
    <>
      {conversionWarnings.length > 0 && (
        <div className="budget-alert">
          <strong>Currency conversion unavailable</strong>
          <span>
            No exchange rates found for: {currencyList}. Amounts in {conversionWarnings.length === 1 ? "this currency" : "these currencies"} cannot
            be converted to {reportingCurrency}. Cells mixing unconvertible currencies are highlighted in red.
          </span>
        </div>
      )}
      <div className="data-mask-toggle">
        <button className="data-mask-btn" type="button" onClick={scrollToCurrentMonth}>Today</button>
        {pendingSaves > 0 && <span className="budget-sync-status">Syncing&hellip;</span>}
      </div>
      <div className="budget-scroll" ref={scrollRef}>
        <table className="budget-table">
          <thead>
            <tr>
              <th className="budget-th budget-sticky-col">Category</th>
              <th className="budget-left-spacer" rowSpan={2}>{isLoadingLeft ? "Loading\u2026" : ""}</th>
              {columnSequence.map((col) => {
                if (col.kind === "year-total") {
                  return (
                    <th key={`total-${col.year}`} className="budget-th budget-year-total" colSpan={col.year === currentYear ? 2 : 1}>
                      Total {col.year}
                    </th>
                  );
                }
                return (
                  <th
                    key={col.month}
                    className={`budget-th${col.month === currentMonth ? " budget-current-month" : ""}`}
                    colSpan={col.month === currentMonth ? 2 : 1}
                    data-month={col.month}
                  >
                    {col.month}
                  </th>
                );
              })}
            </tr>
            <tr>
              <th className="budget-th budget-sticky-col" />
              {columnSequence.map((col) => {
                if (col.kind === "year-total") {
                  if (col.year < currentYear) {
                    return <th key={`total-${col.year}`} className="budget-th-sub budget-year-total">Actual</th>;
                  }
                  if (col.year > currentYear) {
                    return <th key={`total-${col.year}`} className="budget-th-sub budget-year-total">Plan</th>;
                  }
                  return (
                    <Fragment key={`total-${col.year}`}>
                      <th className="budget-th-sub budget-year-total">Plan</th>
                      <th className="budget-th-sub budget-year-total">Actual</th>
                    </Fragment>
                  );
                }
                if (isPastMonth(col.month, currentMonth)) {
                  return <th key={col.month} className="budget-th-sub">Actual</th>;
                }
                if (isFutureMonth(col.month, currentMonth)) {
                  return <th key={col.month} className="budget-th-sub">Plan</th>;
                }
                return (
                  <Fragment key={col.month}>
                    <th className="budget-th-sub budget-cm-plan">Plan</th>
                    <th className="budget-th-sub budget-cm-actual">Actual</th>
                  </Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => {
              const useFilteredSubtotals = effectiveAllowlist !== null;
              // Direction rows show filtered subtotals (only allowed categories) in
              // filtered mode, so they are always safe to display unmasked.
              const dirVis: CellVisibility = { showData: true, maskClass: "" };

              return (
                <Fragment key={block.direction}>
                  <tr className="budget-direction-row">
                    <td className="budget-direction-label budget-sticky-col">{block.label}</td>
                    <td className="budget-left-spacer" />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td>;
                        }
                        const yearSub = useFilteredSubtotals ? (yd.filteredSubtotals.get(block.direction) ?? zeroCellValue) : (yd.directionSubtotals.get(block.direction) ?? zeroCellValue);
                        const isTainted = yd.taintedDirections.has(block.direction);
                        const taintedClass = isTainted ? " budget-error" : "";
                        const isActualOver = col.year >= currentYear && yearSub.actual > yearSub.planned && yearSub.planned > 0 && block.direction === "spend";
                        if (col.year < currentYear) {
                          return (
                            <td
                              key={`total-${col.year}`}
                              className={`budget-cell budget-cell-subtotal budget-year-total${dirVis.maskClass}${taintedClass}${dirVis.showData ? " budget-cell-clickable" : ""}`}
                              onClick={dirVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category: null }) : undefined}
                            >{formatAmount(yearSub.actual)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${dirVis.maskClass}${taintedClass}`}>{formatAmount(yearSub.planned)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${dirVis.maskClass}${taintedClass}`}>{formatAmount(yearSub.planned)}</td>
                            <td
                              className={`budget-cell budget-cell-subtotal budget-year-total${dirVis.maskClass}${taintedClass}${isActualOver ? " budget-over" : ""}${dirVis.showData ? " budget-cell-clickable" : ""}`}
                              onClick={dirVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category: null }) : undefined}
                            >{formatAmount(yearSub.actual)}</td>
                          </Fragment>
                        );
                      }
                      const sub = (useFilteredSubtotals ? filteredSubtotalsMap.get(block.direction)?.get(col.month) : block.subtotals.get(col.month)) ?? zeroCellValue;
                      const isTainted = taintedDirectionMonths.has(`${block.direction}::${col.month}`);
                      const isActualOver = !isPastMonth(col.month, currentMonth) && sub.actual > sub.planned && sub.planned > 0 && block.direction === "spend";
                      return (
                        <Fragment key={col.month}>
                          {renderMonthCells(col.month, sub.planned, sub.actual, isTainted, false, isActualOver, true, dirVis.maskClass, dirVis.showData ? () => setDrillDownFilter({ dateFrom: monthToDateFrom(col.month), dateTo: monthToDateTo(col.month), direction: block.direction, category: null }) : null)}
                        </Fragment>
                      );
                    })}
                  </tr>
                  {block.categories.filter((c) => c !== "" || block.categories.length > 1).map((category) => {
                    const catVis = getCellVisibility(effectiveAllowlist, category);

                    return (
                    <tr key={category} className="budget-category-row">
                      <td className={`budget-category-label budget-sticky-col copyable-cell${catVis.maskClass}`} onClick={() => copyToClipboard(category)}>{category}</td>
                      <td className="budget-left-spacer" />
                      {columnSequence.map((col) => {
                        if (col.kind === "year-total") {
                          const yd = yearComputed.get(col.year);
                          if (yd === undefined) {
                            return col.year === currentYear
                              ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-year-total budget-year-loading">&hellip;</td></Fragment>
                              : <td key={`total-${col.year}`} className="budget-cell budget-year-total budget-year-loading">&hellip;</td>;
                          }
                          const yearCell = yd.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
                          const isTainted = yd.taintedCategories.has(`${block.direction}::${category}`);
                          const taintedClass = isTainted ? " budget-error" : "";
                          const isActualOver = col.year >= currentYear && yearCell.actual > yearCell.planned && yearCell.planned > 0 && block.direction === "spend";
                          if (col.year < currentYear) {
                            return (
                              <td
                                key={`total-${col.year}`}
                                className={`budget-cell budget-year-total${catVis.maskClass}${taintedClass}${catVis.showData ? " budget-cell-clickable" : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category }) : undefined}
                              >{formatAmount(yearCell.actual)}</td>
                            );
                          }
                          if (col.year > currentYear) {
                            return (
                              <td key={`total-${col.year}`} className={`budget-cell budget-year-total${catVis.maskClass}${taintedClass}`}>{formatAmount(yearCell.planned)}</td>
                            );
                          }
                          return (
                            <Fragment key={`total-${col.year}`}>
                              <td className={`budget-cell budget-year-total${catVis.maskClass}${taintedClass}`}>{formatAmount(yearCell.planned)}</td>
                              <td
                                className={`budget-cell budget-year-total${catVis.maskClass}${taintedClass}${isActualOver ? " budget-over" : ""}${catVis.showData ? " budget-cell-clickable" : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category }) : undefined}
                              >{formatAmount(yearCell.actual)}</td>
                            </Fragment>
                          );
                        }
                        const cell = lookupCell(block.cells, col.month, category);
                        const isTainted = taintedCells.has(`${block.direction}::${col.month}::${category}`);
                        const taintedClass = isTainted ? " budget-error" : "";
                        const isPast = isPastMonth(col.month, currentMonth);
                        const isActualOver = !isPast && cell.actual > cell.planned && cell.planned > 0 && block.direction === "spend";
                        const isFuture = isFutureMonth(col.month, currentMonth);

                        const isCurrent = !isPast && !isFuture;

                        return (
                          <Fragment key={col.month}>
                            {!isPast && (
                              <BudgetPlanCell
                                month={col.month}
                                direction={block.direction}
                                category={category}
                                plannedBase={cell.plannedBase}
                                plannedModifier={cell.plannedModifier}
                                planned={cell.planned}
                                hasComment={commentedCells.has(`${col.month}::${block.direction}::${category}`)}
                                showData={catVis.showData}
                                maskClass={catVis.maskClass}
                                taintedClass={taintedClass}
                                isPlanOver={false}
                                cmClass={isCurrent ? " budget-cm-plan" : ""}
                                onPlanSave={handlePlanSave}
                                onFillMonths={handleFillMonths}
                                onCommentPresenceChange={updateCommentCell}
                                onSyncStart={onSyncStart}
                                onSyncEnd={onSyncEnd}
                              />
                            )}
                            {!isFuture && (
                              <td
                                className={`budget-cell${isCurrent ? " budget-cm-actual" : ""}${catVis.maskClass}${taintedClass}${isActualOver ? " budget-over" : ""}${catVis.showData ? " budget-cell-clickable" : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: monthToDateFrom(col.month), dateTo: monthToDateTo(col.month), direction: block.direction, category }) : undefined}
                              >
                                {formatAmount(cell.actual)}
                              </td>
                            )}
                          </Fragment>
                        );
                      })}
                    </tr>
                    );
                  })}
                </Fragment>
              );
            })}

            {(() => {
              const derivedMaskClass = getCellVisibility(effectiveAllowlist, null).maskClass;
              return (
                <>
                  <tr className="budget-direction-row">
                    <td className="budget-direction-label budget-sticky-col">Remainder</td>
                    <td className="budget-left-spacer" />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td>;
                        }
                        const taintedClass = yd.anyTainted ? " budget-error" : "";
                        if (col.year < currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${yd.remainder.actual < 0 ? " budget-over" : ""}`}>{formatAmount(yd.remainder.actual)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${yd.remainder.planned < 0 ? " budget-over" : ""}`}>{formatAmount(yd.remainder.planned)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${yd.remainder.planned < 0 ? " budget-over" : ""}`}>{formatAmount(yd.remainder.planned)}</td>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${yd.remainder.actual < 0 ? " budget-over" : ""}`}>{formatAmount(yd.remainder.actual)}</td>
                          </Fragment>
                        );
                      }
                      const inc = incomeSubtotals?.get(col.month) ?? zeroCellValue;
                      const spd = spendSubtotals?.get(col.month) ?? zeroCellValue;
                      const txf = transferSubtotals?.get(col.month) ?? zeroCellValue;
                      const remainderPlan = inc.planned - spd.planned + txf.planned;
                      const remainderActual = inc.actual - spd.actual + txf.actual;
                      const isTainted = taintedMonths.has(col.month);
                      return (
                        <Fragment key={col.month}>
                          {renderMonthCells(col.month, remainderPlan, remainderActual, isTainted, remainderPlan < 0, remainderActual < 0, true, derivedMaskClass, null)}
                        </Fragment>
                      );
                    })}
                  </tr>

                  {/* FX adjust row: per-month difference between real portfolio change and budget delta */}
                  <tr className="budget-category-row">
                    <td className="budget-category-label budget-sticky-col">FX adjust</td>
                    <td className="budget-left-spacer" />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td>;
                        }
                        const fxVal = yd.yearFxAdjust;
                        if (col.year < currentYear) {
                          return <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}`}>{formatFxAmount(fxVal)}</td>;
                        }
                        if (col.year > currentYear) {
                          return <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}`} />;
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}`} />
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}`}>{formatFxAmount(fxVal)}</td>
                          </Fragment>
                        );
                      }
                      const fx = fxAdjustments.get(col.month);
                      const fxValue = fx ?? 0;
                      const isFuture = col.month > currentMonth;
                      const fxClickable = !isFuture && fx !== undefined;
                      if (isPastMonth(col.month, currentMonth)) {
                        return (
                          <td key={col.month} className={`budget-cell budget-cell-subtotal${derivedMaskClass}${fxClickable ? " budget-cell-clickable" : ""}`} onClick={fxClickable ? () => setFxBreakdownMonth(col.month) : undefined}>
                            {formatFxAmount(fxValue)}
                          </td>
                        );
                      }
                      if (isFuture) {
                        return (
                          <td key={col.month} className={`budget-cell budget-cell-subtotal${derivedMaskClass}`}>
                            {formatFxAmount(0)}
                          </td>
                        );
                      }
                      return (
                        <Fragment key={col.month}>
                          <td className={`budget-cell budget-cm-plan budget-cell-subtotal${derivedMaskClass}`}>
                            {formatFxAmount(0)}
                          </td>
                          <td className={`budget-cell budget-cm-actual budget-cell-subtotal${derivedMaskClass}${fxClickable ? " budget-cell-clickable" : ""}`} onClick={fxClickable ? () => setFxBreakdownMonth(col.month) : undefined}>
                            {formatFxAmount(fxValue)}
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>

                  <tr className="budget-direction-row">
                    <td className="budget-direction-label budget-sticky-col">Balance</td>
                    <td className="budget-left-spacer" />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className="budget-cell budget-cell-subtotal budget-year-total budget-year-loading">&hellip;</td>;
                        }
                        const bal = yd.decemberBalance;
                        const taintedClass = bal.isTainted ? " budget-error" : "";
                        if (col.year < currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${bal.actual < 0 ? " budget-over" : ""}`}>{formatAmount(bal.actual)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${bal.plan < 0 ? " budget-over" : ""}`}>{formatAmount(bal.plan)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${bal.plan < 0 ? " budget-over" : ""}`}>{formatAmount(bal.plan)}</td>
                            <td className={`budget-cell budget-cell-subtotal budget-year-total${derivedMaskClass}${taintedClass}${bal.actual < 0 ? " budget-over" : ""}`}>{formatAmount(bal.actual)}</td>
                          </Fragment>
                        );
                      }
                      const bal = cumulativeBalances.get(col.month)!;
                      return (
                        <Fragment key={col.month}>
                          {renderMonthCells(col.month, bal.plan, bal.actual, bal.isTainted, bal.plan < 0, bal.actual < 0, true, derivedMaskClass, null)}
                        </Fragment>
                      );
                    })}
                  </tr>

                  {hasLiquidityBreakdown && liquidityTiers.map((liq) => (
                    <tr key={`bal-${liq}`} className="budget-category-row">
                      <td className={`budget-category-label budget-sticky-col${derivedMaskClass}`}>{LIQUIDITY_LABELS[liq] ?? liq}</td>
                      <td className="budget-left-spacer" />
                      {columnSequence.map((col) => {
                        if (col.kind === "year-total") {
                          const yd = yearComputed.get(col.year);
                          if (yd === undefined) {
                            return col.year === currentYear
                              ? <Fragment key={`total-${col.year}`}><td className="budget-cell budget-year-total budget-year-loading">&hellip;</td><td className="budget-cell budget-year-total budget-year-loading">&hellip;</td></Fragment>
                              : <td key={`total-${col.year}`} className="budget-cell budget-year-total budget-year-loading">&hellip;</td>;
                          }
                          const liqVal = yd.decemberBalancesByLiquidity[liq] ?? 0;
                          if (col.year < currentYear) {
                            return <td key={`total-${col.year}`} className={`budget-cell budget-year-total${derivedMaskClass}`}>{formatAmount(liqVal)}</td>;
                          }
                          if (col.year > currentYear) {
                            return <td key={`total-${col.year}`} className={`budget-cell budget-year-total${derivedMaskClass}`}>&mdash;</td>;
                          }
                          return (
                            <Fragment key={`total-${col.year}`}>
                              <td className={`budget-cell budget-year-total${derivedMaskClass}`}>&mdash;</td>
                              <td className={`budget-cell budget-year-total${derivedMaskClass}`}>{formatAmount(liqVal)}</td>
                            </Fragment>
                          );
                        }
                        const liqVal = mebByLiq[col.month]?.[liq] ?? 0;
                        if (isFutureMonth(col.month, currentMonth)) {
                          return <td key={col.month} className={`budget-cell${derivedMaskClass}`}>&mdash;</td>;
                        }
                        if (isPastMonth(col.month, currentMonth)) {
                          return <td key={col.month} className={`budget-cell${derivedMaskClass}`}>{formatAmount(liqVal)}</td>;
                        }
                        return (
                          <Fragment key={col.month}>
                            <td className={`budget-cell budget-cm-plan${derivedMaskClass}`}>&mdash;</td>
                            <td className={`budget-cell budget-cm-actual${derivedMaskClass}`}>{formatAmount(liqVal)}</td>
                          </Fragment>
                        );
                      })}
                    </tr>
                  ))}
                </>
              );
            })()}
          </tbody>
        </table>
        <div className="budget-loading-edge">{isLoadingRight ? "Loading\u2026" : ""}</div>
      </div>
      {toastMessage !== null && <div className="copy-toast">{toastMessage}</div>}
      {drillDownFilter !== null && (
        <DrillDownPanel filter={drillDownFilter} categories={allCategories} hints={hints} onClose={handleDrillDownClose} />
      )}
      {fxBreakdownMonth !== null && (
        <FxBreakdownPanel month={fxBreakdownMonth} onClose={() => setFxBreakdownMonth(null)} />
      )}
    </>
  );
};
