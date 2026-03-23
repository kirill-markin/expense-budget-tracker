"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { useCommentPresence } from "@/ui/hooks/useCommentPresence";
import type { FieldHints } from "@/server/transactions/getTransactions";
import type { BudgetRow, ConversionWarning, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import { offsetMonth, getCurrentMonth, generateMonthRange, getYear } from "@/lib/monthUtils";
import type {
  CellValue,
  ColumnEntry,
  CumulativeBalance,
  DirectionBlock,
  YearFetchResult,
  YearTotalComputed,
} from "@/ui/tables/budgetTableLogic";
import {
  LIQUIDITY_ORDER,
  adjustCumulativeBeforeForPrependedRows,
  buildBlocks,
  buildBudgetTaintedState,
  buildColumnSequence,
  computeAllowedSubtotals,
  computeCumulativeBalances,
  computeCumulativeBalancesByLiquidity,
  computeFxAdjustments,
  computeYearTotal,
  getTargetFillMonths,
} from "@/ui/tables/budgetTableLogic";
import { fetchBudgetRange } from "@/ui/tables/budgetTableApi";
import type { DrillDownFilter } from "@/ui/tables/DrillDownPanel";
import styles from "@/ui/tables/BudgetTable.module.css";

const BATCH_SIZE = 6;
const SCROLL_THRESHOLD = 200;

export type BudgetTableProps = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  monthEndBalances: Readonly<Record<string, number>>;
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  initialMonthFrom: string;
  initialMonthTo: string;
  reportingCurrency: string;
  hints: FieldHints;
  refreshToken: string;
}>;

export type BudgetTableController = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  currentMonth: string;
  currentYear: string;
  months: ReadonlyArray<string>;
  blocks: ReadonlyArray<DirectionBlock>;
  columnSequence: ReadonlyArray<ColumnEntry>;
  allCategories: ReadonlyArray<string>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  taintedCells: ReadonlySet<string>;
  taintedDirectionMonths: ReadonlySet<string>;
  taintedMonths: ReadonlySet<string>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  fxAdjustments: ReadonlyMap<string, number>;
  liquidityTiers: ReadonlyArray<string>;
  hasLiquidityBreakdown: boolean;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  commentedCells: ReadonlySet<string>;
  pendingSaves: number;
  isLoadingLeft: boolean;
  isLoadingRight: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  drillDownFilter: DrillDownFilter | null;
  fxBreakdownMonth: string | null;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  scrollToCurrentMonth: () => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
  handlePlanSave: (
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ) => void;
  handleFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => void;
  updateCommentCell: (
    month: string,
    direction: string,
    category: string,
    hasComment: boolean,
  ) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  handleDrillDownClose: (dirty: boolean) => void;
  openFxBreakdown: (month: string) => void;
  closeFxBreakdown: () => void;
}>;

export const useBudgetTableController = (
  props: BudgetTableProps,
): BudgetTableController => {
  const { effectiveAllowlist } = useFilteredMode();
  const {
    commentedCells,
    fetchRange: fetchCommentRange,
    reloadRange: reloadCommentRange,
    updateCell: updateCommentCell,
  } = useCommentPresence(props.initialMonthFrom, props.initialMonthTo);
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  const currentMonth = useMemo(() => getCurrentMonth(), []);
  const currentYear = useMemo(() => getYear(currentMonth), [currentMonth]);

  const [allRows, setAllRows] = useState<ReadonlyArray<BudgetRow>>(props.rows);
  const [loadedFrom, setLoadedFrom] = useState<string>(props.initialMonthFrom);
  const [loadedTo, setLoadedTo] = useState<string>(props.initialMonthTo);
  const [cumBefore, setCumBefore] = useState<CumulativeBefore>(props.cumulativeBefore);
  const [meb, setMeb] = useState<Readonly<Record<string, number>>>(props.monthEndBalances);
  const [mebByLiq, setMebByLiq] = useState<Readonly<Record<string, Readonly<Record<string, number>>>>>(props.monthEndBalancesByLiquidity);
  const [isLoadingLeft, setIsLoadingLeft] = useState<boolean>(false);
  const [isLoadingRight, setIsLoadingRight] = useState<boolean>(false);
  const [pendingSaves, setPendingSaves] = useState<number>(0);
  const [drillDownFilter, setDrillDownFilter] = useState<DrillDownFilter | null>(null);
  const [fxBreakdownMonth, setFxBreakdownMonth] = useState<string | null>(null);

  const onSyncStart = useCallback((): void => {
    setPendingSaves((count) => count + 1);
  }, []);
  const onSyncEnd = useCallback((): void => {
    setPendingSaves((count) => Math.max(0, count - 1));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollWidthRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  const isLoadingLeftRef = useRef<boolean>(false);
  const isLoadingRightRef = useRef<boolean>(false);
  const initialRefreshHandledRef = useRef<boolean>(false);

  const months = useMemo<ReadonlyArray<string>>(
    () => generateMonthRange(loadedFrom, loadedTo),
    [loadedFrom, loadedTo],
  );

  const blocks = useMemo<ReadonlyArray<DirectionBlock>>(
    () => buildBlocks(allRows, months, currentMonth, effectiveAllowlist),
    [allRows, months, currentMonth, effectiveAllowlist],
  );

  const columnSequence = useMemo<ReadonlyArray<ColumnEntry>>(
    () => buildColumnSequence(months),
    [months],
  );

  const allCategories = useMemo<ReadonlyArray<string>>(() => {
    const categories = new Set<string>();
    for (const block of blocks) {
      for (const category of block.categories) {
        categories.add(category);
      }
    }
    return [...categories].sort();
  }, [blocks]);

  const filteredSubtotalsMap = useMemo<ReadonlyMap<string, ReadonlyMap<string, CellValue>>>(() => {
    if (effectiveAllowlist === null) {
      return new Map();
    }

    const result = new Map<string, ReadonlyMap<string, CellValue>>();
    for (const block of blocks) {
      result.set(block.direction, computeAllowedSubtotals(block, months, effectiveAllowlist));
    }
    return result;
  }, [blocks, months, effectiveAllowlist]);

  const incomeSubtotals = blocks.find((block) => block.direction === "income")?.subtotals;
  const spendSubtotals = blocks.find((block) => block.direction === "spend")?.subtotals;
  const transferSubtotals = blocks.find((block) => block.direction === "transfer")?.subtotals;

  const taintedState = useMemo(() => buildBudgetTaintedState(allRows), [allRows]);
  const { taintedCells, taintedDirectionMonths, taintedMonths } = taintedState;

  const cumulativeBalances = useMemo<ReadonlyMap<string, CumulativeBalance>>(
    () =>
      computeCumulativeBalances(
        months,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        cumBefore,
        taintedMonths,
        currentMonth,
        meb,
      ),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, cumBefore, taintedMonths, currentMonth, meb],
  );

  const fxAdjustments = useMemo<ReadonlyMap<string, number>>(
    () => computeFxAdjustments(months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, meb, currentMonth],
  );

  const liquidityTiers = useMemo<ReadonlyArray<string>>(() => {
    const tiers = new Set<string>();
    for (const liquidityMap of Object.values(mebByLiq)) {
      for (const [liquidity, value] of Object.entries(liquidityMap)) {
        if (value !== 0) {
          tiers.add(liquidity);
        }
      }
    }
    return LIQUIDITY_ORDER.filter((liquidity) => tiers.has(liquidity));
  }, [mebByLiq]);

  const hasLiquidityBreakdown = useMemo<boolean>(
    () => liquidityTiers.length > 1 || (liquidityTiers.length === 1 && liquidityTiers[0] !== "high"),
    [liquidityTiers],
  );

  const projectedLiqBalances = useMemo<ReadonlyMap<string, Readonly<Record<string, number>>>>(
    () =>
      computeCumulativeBalancesByLiquidity(
        months,
        incomeSubtotals,
        spendSubtotals,
        transferSubtotals,
        currentMonth,
        mebByLiq,
      ),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, currentMonth, mebByLiq],
  );

  const [yearFetchResults, setYearFetchResults] = useState<ReadonlyMap<string, YearFetchResult>>(new Map());
  const yearFetchingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!initialRefreshHandledRef.current) {
      initialRefreshHandledRef.current = true;
      return;
    }

    fetchBudgetRange(loadedFrom, loadedTo, currentMonth, currentMonth)
      .then((result) => {
        setAllRows(result.rows);
        setCumBefore(result.cumulativeBefore);
        setMeb(result.monthEndBalances);
        setMebByLiq(result.monthEndBalancesByLiquidity);
        reloadCommentRange(loadedFrom, loadedTo);
      })
      .catch((error) => console.error(error));

    setYearFetchResults(new Map());
    yearFetchingRef.current.clear();
  }, [currentMonth, loadedFrom, loadedTo, props.refreshToken, reloadCommentRange]);

  useEffect(() => {
    for (const column of columnSequence) {
      if (column.kind !== "year-total") {
        continue;
      }

      const { year } = column;
      if (yearFetchResults.has(year) || yearFetchingRef.current.has(year)) {
        continue;
      }

      yearFetchingRef.current.add(year);
      fetchBudgetRange(`${year}-01`, `${year}-12`, `${year}-01`, currentMonth)
        .then((result) => {
          setYearFetchResults((previous) => new Map([
            ...previous,
            [
              year,
              {
                rows: result.rows,
                cumulativeBefore: result.cumulativeBefore,
                monthEndBalances: result.monthEndBalances,
                monthEndBalancesByLiquidity: result.monthEndBalancesByLiquidity,
              },
            ],
          ]));
        })
        .catch((error) => console.error(error))
        .finally(() => {
          yearFetchingRef.current.delete(year);
        });
    }
  }, [columnSequence, currentMonth, yearFetchResults]);

  const yearComputed = useMemo<ReadonlyMap<string, YearTotalComputed>>(() => {
    const result = new Map<string, YearTotalComputed>();
    for (const [year, data] of yearFetchResults) {
      result.set(
        year,
        computeYearTotal(
          data.rows,
          data.cumulativeBefore,
          data.monthEndBalances,
          data.monthEndBalancesByLiquidity,
          year,
          currentMonth,
          effectiveAllowlist,
        ),
      );
    }
    return result;
  }, [yearFetchResults, currentMonth, effectiveAllowlist]);

  const handlePlanSave = useCallback((
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ): void => {
    setAllRows((previous) => {
      const rowIndex = previous.findIndex((row) =>
        row.month === month && row.direction === direction && row.category === category);

      if (rowIndex >= 0) {
        const row = previous[rowIndex];
        const plannedBase = kind === "base" ? value : row.plannedBase;
        const plannedModifier = kind === "modifier" ? value : row.plannedModifier;
        const updatedRow: BudgetRow = {
          ...row,
          plannedBase,
          plannedModifier,
          planned: plannedBase + plannedModifier,
        };
        return [...previous.slice(0, rowIndex), updatedRow, ...previous.slice(rowIndex + 1)];
      }

      const plannedBase = kind === "base" ? value : 0;
      const plannedModifier = kind === "modifier" ? value : 0;
      return [
        ...previous,
        {
          month,
          direction,
          category,
          plannedBase,
          plannedModifier,
          planned: plannedBase + plannedModifier,
          actual: 0,
          hasUnconvertible: false,
        },
      ];
    });
  }, []);

  const handleFillMonths = useCallback((
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ): void => {
    const targetMonths = getTargetFillMonths(sourceMonth);
    setAllRows((previous) => {
      const updatedRows = [...previous];

      for (const month of targetMonths) {
        const rowIndex = updatedRows.findIndex((row) =>
          row.month === month && row.direction === direction && row.category === category);

        if (rowIndex >= 0) {
          const row = updatedRows[rowIndex];
          updatedRows[rowIndex] = {
            ...row,
            plannedBase: baseValue,
            planned: baseValue + row.plannedModifier,
          };
        } else {
          updatedRows.push({
            month,
            direction,
            category,
            plannedBase: baseValue,
            plannedModifier: 0,
            planned: baseValue,
            actual: 0,
            hasUnconvertible: false,
          });
        }
      }

      return updatedRows;
    });
  }, []);

  const refreshLoadedRange = useCallback((): void => {
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
  }, [currentMonth, loadedFrom, loadedTo]);

  const handleDrillDownClose = useCallback((dirty: boolean): void => {
    setDrillDownFilter(null);
    if (!dirty) {
      return;
    }

    refreshLoadedRange();
  }, [refreshLoadedRange]);

  const loadLeft = useCallback(async (): Promise<void> => {
    if (isLoadingLeftRef.current) {
      return;
    }

    isLoadingLeftRef.current = true;
    setIsLoadingLeft(true);

    const newTo = offsetMonth(loadedFrom, -1);
    const newFrom = offsetMonth(loadedFrom, -BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth);
      const prependedRows = result.rows;

      const scrollElement = scrollRef.current;
      if (scrollElement !== null) {
        prevScrollWidthRef.current = scrollElement.scrollWidth;
        isPrependingRef.current = true;
      }

      setAllRows((previous) => [...prependedRows, ...previous]);
      setCumBefore((previous) => adjustCumulativeBeforeForPrependedRows(previous, prependedRows));
      setLoadedFrom(newFrom);
      setMeb((previous) => ({ ...previous, ...result.monthEndBalances }));
      setMebByLiq((previous) => ({ ...previous, ...result.monthEndBalancesByLiquidity }));
      fetchCommentRange(newFrom, newTo);
    } finally {
      isLoadingLeftRef.current = false;
      setIsLoadingLeft(false);
    }
  }, [currentMonth, fetchCommentRange, loadedFrom]);

  const loadRight = useCallback(async (): Promise<void> => {
    if (isLoadingRightRef.current) {
      return;
    }

    isLoadingRightRef.current = true;
    setIsLoadingRight(true);

    const newFrom = offsetMonth(loadedTo, 1);
    const newTo = offsetMonth(loadedTo, BATCH_SIZE);

    try {
      const result = await fetchBudgetRange(newFrom, newTo, currentMonth, currentMonth);
      setAllRows((previous) => [...previous, ...result.rows]);
      setLoadedTo(newTo);
      setMeb((previous) => ({ ...previous, ...result.monthEndBalances }));
      setMebByLiq((previous) => ({ ...previous, ...result.monthEndBalancesByLiquidity }));
      fetchCommentRange(newFrom, newTo);
    } finally {
      isLoadingRightRef.current = false;
      setIsLoadingRight(false);
    }
  }, [currentMonth, fetchCommentRange, loadedTo]);

  useLayoutEffect(() => {
    if (!isPrependingRef.current) {
      return;
    }

    isPrependingRef.current = false;

    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const scrollDelta = scrollElement.scrollWidth - prevScrollWidthRef.current;
    scrollElement.scrollLeft += isRtl ? -scrollDelta : scrollDelta;
  });

  const scrollToCurrentMonth = useCallback((): void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const monthElement = scrollElement.querySelector<HTMLElement>(`[data-month="${currentMonth}"]`);
    if (monthElement === null) {
      return;
    }

    const containerRect = scrollElement.getBoundingClientRect();
    const monthRect = monthElement.getBoundingClientRect();
    const stickyColumn = scrollElement.querySelector<HTMLElement>(`.${styles.stickyCol}`);
    const stickyWidth = stickyColumn !== null ? stickyColumn.offsetWidth : 0;

    if (isRtl) {
      const stickyEnd = containerRect.right - stickyWidth;
      scrollElement.scrollLeft -= stickyEnd - monthRect.right;
    } else {
      const stickyEnd = containerRect.left + stickyWidth;
      scrollElement.scrollLeft += monthRect.left - stickyEnd;
    }
  }, [currentMonth, isRtl]);

  useLayoutEffect(() => {
    scrollToCurrentMonth();
  }, [scrollToCurrentMonth]);

  useEffect(() => {
    if (pendingSaves === 0) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [pendingSaves]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    let rafId = 0;
    const handleScroll = (): void => {
      if (rafId !== 0) {
        return;
      }

      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const scrollStart = isRtl ? -scrollElement.scrollLeft : scrollElement.scrollLeft;
        const scrollEnd =
          scrollElement.scrollWidth - Math.abs(scrollElement.scrollLeft) - scrollElement.clientWidth;

        if (scrollStart < SCROLL_THRESHOLD) {
          void loadLeft();
        }
        if (scrollEnd < SCROLL_THRESHOLD) {
          void loadRight();
        }
      });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isRtl, loadLeft, loadRight]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const tableHead = scrollElement.querySelector<HTMLElement>("thead");
    if (tableHead === null) {
      return;
    }

    let startX = 0;
    let startScrollLeft = 0;

    const onMouseMove = (event: MouseEvent): void => {
      scrollElement.scrollLeft = startScrollLeft - (event.pageX - startX);
    };

    const onMouseUp = (): void => {
      scrollElement.classList.remove(styles.dragging);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    const onMouseDown = (event: MouseEvent): void => {
      event.preventDefault();
      startX = event.pageX;
      startScrollLeft = scrollElement.scrollLeft;
      scrollElement.classList.add(styles.dragging);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    tableHead.addEventListener("mousedown", onMouseDown);
    return () => {
      tableHead.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const openDrillDown = useCallback((filter: DrillDownFilter): void => {
    setDrillDownFilter(filter);
  }, []);

  const openFxBreakdown = useCallback((month: string): void => {
    setFxBreakdownMonth(month);
  }, []);

  const closeFxBreakdown = useCallback((): void => {
    setFxBreakdownMonth(null);
  }, []);

  return {
    effectiveAllowlist,
    currentMonth,
    currentYear,
    months,
    blocks,
    columnSequence,
    allCategories,
    filteredSubtotalsMap,
    incomeSubtotals,
    spendSubtotals,
    transferSubtotals,
    taintedCells,
    taintedDirectionMonths,
    taintedMonths,
    cumulativeBalances,
    fxAdjustments,
    liquidityTiers,
    hasLiquidityBreakdown,
    projectedLiqBalances,
    yearComputed,
    commentedCells,
    pendingSaves,
    isLoadingLeft,
    isLoadingRight,
    scrollRef,
    drillDownFilter,
    fxBreakdownMonth,
    mebByLiq,
    scrollToCurrentMonth,
    onSyncStart,
    onSyncEnd,
    handlePlanSave,
    handleFillMonths,
    updateCommentCell,
    openDrillDown,
    handleDrillDownClose,
    openFxBreakdown,
    closeFxBreakdown,
  };
};
