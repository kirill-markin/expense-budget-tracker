"use client";

import { Fragment, type ReactElement } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import type { FieldHints } from "@/server/transactions/getTransactions";
import { getCellVisibility, type CellVisibility } from "@/lib/dataMask";
import { offsetMonth, getCurrentMonth, generateMonthRange, getYear } from "@/lib/monthUtils";
import type { BudgetRow, ConversionWarning, CumulativeBefore } from "@/server/budget/getBudgetGrid";
import alertStyles from "@/ui/Alert.module.css";
import { useCommentPresence } from "@/ui/hooks/useCommentPresence";
import { useCopyToast } from "@/ui/hooks/useCopyToast";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { useFormat } from "@/ui/FormatProvider";
import { DrillDownPanel, type DrillDownFilter } from "@/ui/tables/DrillDownPanel";
import { FxBreakdownPanel } from "@/ui/tables/FxBreakdownPanel";
import type { CellValue, ColumnEntry, CumulativeBalance, YearFetchResult, YearTotalComputed } from "@/ui/tables/budgetTableLogic";
import { zeroCellValue, LIQUIDITY_ORDER, lookupCell, formatAmount, formatFxAmount, buildBlocks, buildColumnSequence, computeCumulativeBalances, computeCumulativeBalancesByLiquidity, computeFxAdjustments, computeAllowedSubtotals, computeYearTotal, isPastMonth, isFutureMonth, monthToDateFrom, monthToDateTo, getTargetFillMonths } from "@/ui/tables/budgetTableLogic";
import { fetchBudgetRange } from "@/ui/tables/budgetTableApi";
import { BudgetPlanCell } from "@/ui/tables/BudgetPlanCell";
import styles from "@/ui/tables/BudgetTable.module.css";

const BATCH_SIZE = 6;
const SCROLL_THRESHOLD = 200;

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

export const BudgetTable = (props: Props): ReactElement => {
  const { conversionWarnings, initialMonthFrom, initialMonthTo, reportingCurrency, hints } = props;
  const { effectiveAllowlist } = useFilteredMode();
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
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

  const projectedLiqBalances = useMemo<ReadonlyMap<string, Readonly<Record<string, number>>>>(
    () => computeCumulativeBalancesByLiquidity(months, incomeSubtotals, spendSubtotals, transferSubtotals, currentMonth, mebByLiq),
    [months, incomeSubtotals, spendSubtotals, transferSubtotals, currentMonth, mebByLiq],
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
    el.scrollLeft += isRtl ? -delta : delta;
  });

  const scrollToCurrentMonth = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;

    const monthEl = el.querySelector<HTMLElement>(`[data-month="${currentMonth}"]`);
    if (monthEl === null) return;

    const containerRect = el.getBoundingClientRect();
    const monthRect = monthEl.getBoundingClientRect();
    const stickyCol = el.querySelector<HTMLElement>(`.${styles.stickyCol}`);
    const stickyWidth = stickyCol !== null ? stickyCol.offsetWidth : 0;
    const borderOffset = 0;

    if (isRtl) {
      const stickyEnd = containerRect.right - stickyWidth;
      el.scrollLeft -= stickyEnd - monthRect.right - borderOffset;
    } else {
      const stickyEnd = containerRect.left + stickyWidth;
      el.scrollLeft += monthRect.left - stickyEnd - borderOffset;
    }
  }, [currentMonth, isRtl]);

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
        const scrollStart = isRtl ? -el.scrollLeft : el.scrollLeft;
        const scrollEnd = el.scrollWidth - Math.abs(el.scrollLeft) - el.clientWidth;
        if (scrollStart < SCROLL_THRESHOLD) {
          void loadLeft();
        }
        if (scrollEnd < SCROLL_THRESHOLD) {
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
      el.classList.remove(styles.dragging);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault();
      startX = e.pageX;
      startScrollLeft = el.scrollLeft;
      el.classList.add(styles.dragging);
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
    return <p className={styles.empty}>{t("budget.noData")}</p>;
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
    const subtotalClass = isSubtotal ? ` ${styles.cellSubtotal}` : "";
    const taintedClass = isTainted ? ` ${styles.error}` : "";
    if (isPastMonth(month, currentMonth)) {
      const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";
      return (
        <td
          className={`${styles.cell}${subtotalClass}${localMaskClass}${taintedClass}${clickableClass}`}
          onClick={onActualClick ?? undefined}
        >
          {formatAmount(actual, numberFormat)}
        </td>
      );
    }

    if (isFutureMonth(month, currentMonth)) {
      return (
        <td className={`${styles.cell}${subtotalClass}${localMaskClass}${taintedClass}${isPlanOver ? ` ${styles.over}` : ""}`}>
          {formatAmount(planned, numberFormat)}
        </td>
      );
    }

    const clickableClass = onActualClick !== null ? ` ${styles.cellClickable}` : "";

    return (
      <Fragment>
        <td className={`${styles.cell} ${styles.currentMonthPlan}${subtotalClass}${localMaskClass}${taintedClass}${isPlanOver ? ` ${styles.over}` : ""}`}>
          {formatAmount(planned, numberFormat)}
        </td>
        <td
          className={`${styles.cell} ${styles.currentMonthActual}${subtotalClass}${localMaskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${clickableClass}`}
          onClick={onActualClick ?? undefined}
        >
          {formatAmount(actual, numberFormat)}
        </td>
      </Fragment>
    );
  };

  return (
    <>
      {conversionWarnings.length > 0 && (
        <div className={alertStyles.alert}>
          <strong>{t("budget.conversionTitle")}</strong>
          <span>
            {t("budget.conversionMessage", {
              currencies: currencyList,
              qualifier: conversionWarnings.length === 1 ? t("budget.conversionSingular") : t("budget.conversionPlural"),
              currency: reportingCurrency,
            })}
          </span>
        </div>
      )}
      <div className={styles.alertBar}>
        <button className={styles.todayButton} type="button" onClick={scrollToCurrentMonth}>{t("common.today")}</button>
        {pendingSaves > 0 && <span className={styles.syncStatus}>{t("common.syncing")}</span>}
      </div>
      <div className={styles.scroll} ref={scrollRef}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={`${styles.headCell} ${styles.stickyCol}`}>{t("budget.category")}</th>
              <th className={styles.leftSpacer} rowSpan={2}>{isLoadingLeft ? t("common.loading") : ""}</th>
              {columnSequence.map((col) => {
                if (col.kind === "year-total") {
                  return (
                    <th key={`total-${col.year}`} className={`${styles.headCell} ${styles.yearTotal}`} colSpan={col.year === currentYear ? 2 : 1}>
                      {t("budget.total")} {col.year}
                    </th>
                  );
                }
                return (
                  <th
                    key={col.month}
                    className={`${styles.headCell}${col.month === currentMonth ? ` ${styles.currentMonth}` : ""}`}
                    colSpan={col.month === currentMonth ? 2 : 1}
                    data-month={col.month}
                  >
                    {col.month}
                  </th>
                );
              })}
            </tr>
            <tr>
              <th className={`${styles.headCell} ${styles.stickyCol}`} />
              {columnSequence.map((col) => {
                if (col.kind === "year-total") {
                  if (col.year < currentYear) {
                    return <th key={`total-${col.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>;
                  }
                  if (col.year > currentYear) {
                    return <th key={`total-${col.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>;
                  }
                  return (
                    <Fragment key={`total-${col.year}`}>
                      <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>
                      <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>
                    </Fragment>
                  );
                }
                if (isPastMonth(col.month, currentMonth)) {
                  return <th key={col.month} className={styles.subHeadCell}>{t("budget.actual")}</th>;
                }
                if (isFutureMonth(col.month, currentMonth)) {
                  return <th key={col.month} className={styles.subHeadCell}>{t("budget.plan")}</th>;
                }
                return (
                  <Fragment key={col.month}>
                    <th className={`${styles.subHeadCell} ${styles.currentMonthPlan}`}>{t("budget.plan")}</th>
                    <th className={`${styles.subHeadCell} ${styles.currentMonthActual}`}>{t("budget.actual")}</th>
                  </Fragment>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {blocks.map((block) => {
              const useFilteredSubtotals = effectiveAllowlist !== null;
              const allowedCategoriesArray: ReadonlyArray<string> | null =
                effectiveAllowlist !== null ? [...effectiveAllowlist] : null;
              // Direction rows show filtered subtotals (only allowed categories) in
              // filtered mode, so they are always safe to display unmasked.
              const dirVis: CellVisibility = { showData: true, maskClass: "" };

              return (
                <Fragment key={block.direction}>
                  <tr className={styles.directionRow}>
                    <td className={`${styles.directionLabel} ${styles.stickyCol}`}>{t(`budget.direction${block.direction.charAt(0).toUpperCase()}${block.direction.slice(1)}`)}</td>
                    <td className={styles.leftSpacer} />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                        }
                        const yearSub = useFilteredSubtotals ? (yd.filteredSubtotals.get(block.direction) ?? zeroCellValue) : (yd.directionSubtotals.get(block.direction) ?? zeroCellValue);
                        const isTainted = yd.taintedDirections.has(block.direction);
                        const taintedClass = isTainted ? ` ${styles.error}` : "";
                        const isActualOver = col.year >= currentYear && yearSub.actual > yearSub.planned && yearSub.planned > 0 && block.direction === "spend";
                        if (col.year < currentYear) {
                          return (
                            <td
                              key={`total-${col.year}`}
                              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                              onClick={dirVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category: null, categories: allowedCategoriesArray }) : undefined}
                            >{formatAmount(yearSub.actual, numberFormat)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}`}>{formatAmount(yearSub.planned, numberFormat)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}`}>{formatAmount(yearSub.planned, numberFormat)}</td>
                            <td
                              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${dirVis.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                              onClick={dirVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category: null, categories: allowedCategoriesArray }) : undefined}
                            >{formatAmount(yearSub.actual, numberFormat)}</td>
                          </Fragment>
                        );
                      }
                      const sub = (useFilteredSubtotals ? filteredSubtotalsMap.get(block.direction)?.get(col.month) : block.subtotals.get(col.month)) ?? zeroCellValue;
                      const isTainted = taintedDirectionMonths.has(`${block.direction}::${col.month}`);
                      const isActualOver = !isPastMonth(col.month, currentMonth) && sub.actual > sub.planned && sub.planned > 0 && block.direction === "spend";
                      return (
                        <Fragment key={col.month}>
                          {renderMonthCells(col.month, sub.planned, sub.actual, isTainted, false, isActualOver, true, dirVis.maskClass, dirVis.showData ? () => setDrillDownFilter({ dateFrom: monthToDateFrom(col.month), dateTo: monthToDateTo(col.month), direction: block.direction, category: null, categories: allowedCategoriesArray }) : null)}
                        </Fragment>
                      );
                    })}
                  </tr>
                    {block.categories.filter((c) => c !== "" || block.categories.length > 1).map((category) => {
                      const catVis = getCellVisibility(effectiveAllowlist, category);

                      return (
                    <tr key={category} className={styles.categoryRow}>
                      <td className={`${styles.categoryLabel} ${styles.stickyCol} copyable-cell${catVis.maskClass}`} onClick={() => copyToClipboard(category)}>{category}</td>
                      <td className={styles.leftSpacer} />
                      {columnSequence.map((col) => {
                        if (col.kind === "year-total") {
                          const yd = yearComputed.get(col.year);
                          if (yd === undefined) {
                            return col.year === currentYear
                              ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                              : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                          }
                          const yearCell = yd.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
                          const isTainted = yd.taintedCategories.has(`${block.direction}::${category}`);
                          const taintedClass = isTainted ? ` ${styles.error}` : "";
                          const isActualOver = col.year >= currentYear && yearCell.actual > yearCell.planned && yearCell.planned > 0 && block.direction === "spend";
                          if (col.year < currentYear) {
                            return (
                              <td
                                key={`total-${col.year}`}
                                className={`${styles.cell} ${styles.yearTotal}${catVis.maskClass}${taintedClass}${catVis.showData ? ` ${styles.cellClickable}` : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category, categories: null }) : undefined}
                              >{formatAmount(yearCell.actual, numberFormat)}</td>
                            );
                          }
                          if (col.year > currentYear) {
                            return (
                              <td key={`total-${col.year}`} className={`${styles.cell} ${styles.yearTotal}${catVis.maskClass}${taintedClass}`}>{formatAmount(yearCell.planned, numberFormat)}</td>
                            );
                          }
                          return (
                            <Fragment key={`total-${col.year}`}>
                              <td className={`${styles.cell} ${styles.yearTotal}${catVis.maskClass}${taintedClass}`}>{formatAmount(yearCell.planned, numberFormat)}</td>
                              <td
                                className={`${styles.cell} ${styles.yearTotal}${catVis.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${catVis.showData ? ` ${styles.cellClickable}` : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: `${col.year}-01-01`, dateTo: `${col.year}-12-31`, direction: block.direction, category, categories: null }) : undefined}
                              >{formatAmount(yearCell.actual, numberFormat)}</td>
                            </Fragment>
                          );
                        }
                        const cell = lookupCell(block.cells, col.month, category);
                        const isTainted = taintedCells.has(`${block.direction}::${col.month}::${category}`);
                        const taintedClass = isTainted ? ` ${styles.error}` : "";
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
                                cmClass={isCurrent ? ` ${styles.currentMonthPlan}` : ""}
                                onPlanSave={handlePlanSave}
                                onFillMonths={handleFillMonths}
                                onCommentPresenceChange={updateCommentCell}
                                onSyncStart={onSyncStart}
                                onSyncEnd={onSyncEnd}
                              />
                            )}
                            {!isFuture && (
                              <td
                                className={`${styles.cell}${isCurrent ? ` ${styles.currentMonthActual}` : ""}${catVis.maskClass}${taintedClass}${isActualOver ? ` ${styles.over}` : ""}${catVis.showData ? ` ${styles.cellClickable}` : ""}`}
                                onClick={catVis.showData ? () => setDrillDownFilter({ dateFrom: monthToDateFrom(col.month), dateTo: monthToDateTo(col.month), direction: block.direction, category, categories: null }) : undefined}
                              >
                                {formatAmount(cell.actual, numberFormat)}
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
                  <tr className={styles.directionRow}>
                    <td className={`${styles.directionLabel} ${styles.stickyCol}`}>{t("budget.remainder")}</td>
                    <td className={styles.leftSpacer} />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                        }
                        const taintedClass = yd.anyTainted ? ` ${styles.error}` : "";
                        if (col.year < currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yd.remainder.actual < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(yd.remainder.actual, numberFormat)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yd.remainder.planned < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(yd.remainder.planned, numberFormat)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yd.remainder.planned < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(yd.remainder.planned, numberFormat)}</td>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${yd.remainder.actual < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(yd.remainder.actual, numberFormat)}</td>
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
                  <tr className={styles.categoryRow}>
                    <td className={`${styles.categoryLabel} ${styles.stickyCol}`}>{t("budget.fxAdjust")}</td>
                    <td className={styles.leftSpacer} />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                        }
                        const fxVal = yd.yearFxAdjust;
                        if (col.year < currentYear) {
                          return <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>{formatFxAmount(fxVal, numberFormat)}</td>;
                        }
                        if (col.year > currentYear) {
                          return <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />;
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>{formatFxAmount(fxVal, numberFormat)}</td>
                          </Fragment>
                        );
                      }
                      const fx = fxAdjustments.get(col.month);
                      const fxValue = fx ?? 0;
                      const isFuture = col.month > currentMonth;
                      const fxClickable = !isFuture && fx !== undefined;
                      if (isPastMonth(col.month, currentMonth)) {
                        return (
                          <td key={col.month} className={`${styles.cell} ${styles.cellSubtotal}${derivedMaskClass}${fxClickable ? ` ${styles.cellClickable}` : ""}`} onClick={fxClickable ? () => setFxBreakdownMonth(col.month) : undefined}>
                            {formatFxAmount(fxValue, numberFormat)}
                          </td>
                        );
                      }
                      if (isFuture) {
                        return (
                          <td key={col.month} className={`${styles.cell} ${styles.cellSubtotal}${derivedMaskClass}`}>
                            {formatFxAmount(0, numberFormat)}
                          </td>
                        );
                      }
                      return (
                        <Fragment key={col.month}>
                          <td className={`${styles.cell} ${styles.currentMonthPlan} ${styles.cellSubtotal}${derivedMaskClass}`}>
                            {formatFxAmount(0, numberFormat)}
                          </td>
                          <td className={`${styles.cell} ${styles.currentMonthActual} ${styles.cellSubtotal}${derivedMaskClass}${fxClickable ? ` ${styles.cellClickable}` : ""}`} onClick={fxClickable ? () => setFxBreakdownMonth(col.month) : undefined}>
                            {formatFxAmount(fxValue, numberFormat)}
                          </td>
                        </Fragment>
                      );
                    })}
                  </tr>

                  <tr className={styles.directionRow}>
                    <td className={`${styles.directionLabel} ${styles.stickyCol}`}>{t("budget.balance")}</td>
                    <td className={styles.leftSpacer} />
                    {columnSequence.map((col) => {
                      if (col.kind === "year-total") {
                        const yd = yearComputed.get(col.year);
                        if (yd === undefined) {
                          return col.year === currentYear
                            ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                            : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                        }
                        const bal = yd.decemberBalance;
                        const taintedClass = bal.isTainted ? ` ${styles.error}` : "";
                        if (col.year < currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${bal.actual < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(bal.actual, numberFormat)}</td>
                          );
                        }
                        if (col.year > currentYear) {
                          return (
                            <td key={`total-${col.year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${bal.plan < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(bal.plan, numberFormat)}</td>
                          );
                        }
                        return (
                          <Fragment key={`total-${col.year}`}>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${bal.plan < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(bal.plan, numberFormat)}</td>
                            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${bal.actual < 0 ? ` ${styles.over}` : ""}`}>{formatAmount(bal.actual, numberFormat)}</td>
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
                    <tr key={`bal-${liq}`} className={styles.categoryRow}>
                      <td className={`${styles.categoryLabel} ${styles.stickyCol}${derivedMaskClass}`}>{t(`budget.liquidity${liq.charAt(0).toUpperCase()}${liq.slice(1)}`)}</td>
                      <td className={styles.leftSpacer} />
                      {columnSequence.map((col) => {
                        if (col.kind === "year-total") {
                          const yd = yearComputed.get(col.year);
                          if (yd === undefined) {
                            return col.year === currentYear
                              ? <Fragment key={`total-${col.year}`}><td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td><td className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td></Fragment>
                              : <td key={`total-${col.year}`} className={`${styles.cell} ${styles.yearTotal} ${styles.yearLoading}`}>&hellip;</td>;
                          }
                          const liqVal = yd.decemberBalancesByLiquidity[liq] ?? 0;
                          const liqPlan = yd.decemberBalancesByLiquidityPlan[liq] ?? 0;
                          if (col.year < currentYear) {
                            return <td key={`total-${col.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>{formatAmount(liqVal, numberFormat)}</td>;
                          }
                          if (col.year > currentYear) {
                            return <td key={`total-${col.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>{formatAmount(liqPlan, numberFormat)}</td>;
                          }
                          return (
                            <Fragment key={`total-${col.year}`}>
                              <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>{formatAmount(liqPlan, numberFormat)}</td>
                              <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>{formatAmount(liqVal, numberFormat)}</td>
                            </Fragment>
                          );
                        }
                        const liqVal = mebByLiq[col.month]?.[liq] ?? 0;
                        const projectedLiqVal = projectedLiqBalances.get(col.month)?.[liq] ?? 0;
                        if (isFutureMonth(col.month, currentMonth)) {
                          return <td key={col.month} className={`${styles.cell}${derivedMaskClass}`}>{formatAmount(projectedLiqVal, numberFormat)}</td>;
                        }
                        if (isPastMonth(col.month, currentMonth)) {
                          return <td key={col.month} className={`${styles.cell}${derivedMaskClass}`}>{formatAmount(liqVal, numberFormat)}</td>;
                        }
                        return (
                          <Fragment key={col.month}>
                            <td className={`${styles.cell} ${styles.currentMonthPlan}${derivedMaskClass}`}>{formatAmount(projectedLiqVal, numberFormat)}</td>
                            <td className={`${styles.cell} ${styles.currentMonthActual}${derivedMaskClass}`}>{formatAmount(liqVal, numberFormat)}</td>
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
        <div className={styles.loadingEdge}>{isLoadingRight ? t("common.loading") : ""}</div>
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
