"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { BudgetPlansMode } from "@/ui/tables/budget/budgetTableLogic";
import {
  getBudgetScrollInlineOffset,
  getBudgetScrollLeftDelta,
  selectBudgetScrollAnchorRestoration,
  selectLeadingBudgetScrollAnchor,
  type BudgetScrollAnchor,
  type BudgetScrollAnchorCandidate,
} from "@/ui/tables/budget/controller/budgetScrollAnchor";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

const HORIZONTAL_PREFETCH_MARGIN = "0px 600px 0px 600px";
const MONTH_OBSERVATION_ATTRIBUTE = "data-budget-month";
const YEAR_OBSERVATION_ATTRIBUTE = "data-budget-year-total";

type UseBudgetTableViewportParams = Readonly<{
  currentMonth: string;
  plansMode: BudgetPlansMode;
  pendingSaves: number;
  onMonthsObserved: (monthFrom: string, monthTo: string) => void;
  onYearTotalsObserved: (years: ReadonlySet<string>) => void;
}>;

export type BudgetTableViewportState = Readonly<{
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToCurrentMonth: () => void;
}>;

export const useBudgetTableViewport = ({
  currentMonth,
  plansMode,
  pendingSaves,
  onMonthsObserved,
  onYearTotalsObserved,
}: UseBudgetTableViewportParams): BudgetTableViewportState => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef<BudgetScrollAnchor | null>(null);
  const anchorMeasurementFrameRef = useRef<number | null>(null);
  const isPlansModeLayoutSettledRef = useRef(false);
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  // Inline start of the scrollable value area: the first pixel the sticky
  // category column does not cover.
  const getValueAreaInlineStart = useCallback((
    scrollElement: HTMLDivElement,
  ): number => {
    const containerRect = scrollElement.getBoundingClientRect();
    const stickyColumn = scrollElement.querySelector<HTMLElement>(`.${styles.stickyCol}`);
    const stickyWidth = stickyColumn !== null ? stickyColumn.offsetWidth : 0;
    return isRtl
      ? containerRect.right - stickyWidth
      : containerRect.left + stickyWidth;
  }, [isRtl]);

  const scrollMonthToInlineOffset = useCallback((
    monthElement: HTMLElement,
    scrollElement: HTMLDivElement,
    inlineOffset: number,
  ): void => {
    const monthRect = monthElement.getBoundingClientRect();
    const currentInlineOffset = getBudgetScrollInlineOffset(
      getValueAreaInlineStart(scrollElement),
      monthRect.left,
      monthRect.right,
      isRtl,
    );
    scrollElement.scrollLeft += getBudgetScrollLeftDelta(
      currentInlineOffset,
      inlineOffset,
      isRtl,
    );
  }, [getValueAreaInlineStart, isRtl]);

  const scrollToCurrentMonth = useCallback((): void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const monthElement = scrollElement.querySelector<HTMLElement>(`[data-month="${currentMonth}"]`);
    if (monthElement === null) {
      return;
    }

    scrollMonthToInlineOffset(monthElement, scrollElement, 0);
  }, [currentMonth, scrollMonthToInlineOffset]);

  // Where the user is reading right now: the month at the inline start of the
  // value area and how far into the area it begins. Measured from the live
  // geometry, so the stored anchor never describes a position the user has
  // already left and never needs invalidating.
  const measureScrollAnchor = useCallback((): void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const valueAreaInlineStart = getValueAreaInlineStart(scrollElement);
    const candidates: Array<BudgetScrollAnchorCandidate> = [];
    for (const element of scrollElement.querySelectorAll<HTMLElement>(
      `[${MONTH_OBSERVATION_ATTRIBUTE}]`,
    )) {
      const month = element.getAttribute(MONTH_OBSERVATION_ATTRIBUTE);
      if (month === null) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      candidates.push({
        month,
        inlineOffset: getBudgetScrollInlineOffset(
          valueAreaInlineStart,
          rect.left,
          rect.right,
          isRtl,
        ),
        inlineSize: rect.width,
      });
    }

    scrollAnchorRef.current = selectLeadingBudgetScrollAnchor(candidates);
  }, [getValueAreaInlineStart, isRtl]);

  // One measurement per animation frame keeps a continuous drag cheap and
  // still leaves the anchor at most a frame behind the viewport.
  //
  // A programmatic scroll cannot corrupt the next restoration: the restoration
  // below runs synchronously inside the layout commit, so neither a scroll
  // event nor a queued frame can land between the new columns and the
  // restoration, and the scroll event the restoration itself dispatches a
  // frame later only re-measures the position it has just set.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const handleScroll = (): void => {
      if (anchorMeasurementFrameRef.current !== null) {
        return;
      }
      anchorMeasurementFrameRef.current = requestAnimationFrame((): void => {
        anchorMeasurementFrameRef.current = null;
        measureScrollAnchor();
      });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      if (anchorMeasurementFrameRef.current !== null) {
        cancelAnimationFrame(anchorMeasurementFrameRef.current);
        anchorMeasurementFrameRef.current = null;
      }
    };
  }, [measureScrollAnchor]);

  useLayoutEffect(() => {
    scrollToCurrentMonth();
    // Seeds the anchor from the first laid-out rows, so a mode switch made
    // without scrolling at all still restores a measured position.
    measureScrollAnchor();
  }, [measureScrollAnchor, scrollToCurrentMonth]);

  // Switching the mode doubles or halves the width of every elapsed month, so
  // the same `scrollLeft` points at completely different months afterwards.
  // This runs once the new value columns and the new inline size are
  // committed, so it works on the geometry the user is about to see.
  useLayoutEffect(() => {
    if (!isPlansModeLayoutSettledRef.current) {
      isPlansModeLayoutSettledRef.current = true;
      return;
    }

    // The new columns are committed with the old `scrollLeft`, so measuring
    // now would read an arbitrary month: only the measurement taken before
    // this commit still says what the user was reading.
    const restoration = selectBudgetScrollAnchorRestoration(
      scrollAnchorRef.current,
    );
    if (anchorMeasurementFrameRef.current !== null) {
      cancelAnimationFrame(anchorMeasurementFrameRef.current);
      anchorMeasurementFrameRef.current = null;
    }

    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const monthElement = restoration.action === "restore"
      ? scrollElement.querySelector<HTMLElement>(
        `[${MONTH_OBSERVATION_ATTRIBUTE}="${restoration.anchor.month}"]`,
      )
      : null;
    if (restoration.action === "restore" && monthElement !== null) {
      scrollMonthToInlineOffset(
        monthElement,
        scrollElement,
        restoration.anchor.inlineOffset,
      );
    } else {
      scrollToCurrentMonth();
    }

    // The anchor has to describe the columns now on screen: the scroll above
    // may have been clamped to the new maximum, and the next switch must not
    // restore an offset measured in the previous column widths.
    measureScrollAnchor();
  }, [
    measureScrollAnchor,
    plansMode,
    scrollMonthToInlineOffset,
    scrollToCurrentMonth,
  ]);

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

    const intersectingMonths = new Set<string>();
    const intersectingYears = new Set<string>();
    const observer = new IntersectionObserver(
      (entries): void => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const month = target.getAttribute(MONTH_OBSERVATION_ATTRIBUTE);
          const year = target.getAttribute(YEAR_OBSERVATION_ATTRIBUTE);

          if (month !== null) {
            if (entry.isIntersecting) {
              intersectingMonths.add(month);
            } else {
              intersectingMonths.delete(month);
            }
          }
          if (year !== null) {
            if (entry.isIntersecting) {
              intersectingYears.add(year);
            } else {
              intersectingYears.delete(year);
            }
          }
        }

        if (intersectingMonths.size > 0) {
          const visibleMonths = [...intersectingMonths].sort();
          onMonthsObserved(visibleMonths[0], visibleMonths[visibleMonths.length - 1]);
        }
        if (intersectingYears.size > 0) {
          onYearTotalsObserved(new Set(intersectingYears));
        }
      },
      {
        root: scrollElement,
        rootMargin: HORIZONTAL_PREFETCH_MARGIN,
      },
    );

    for (const target of scrollElement.querySelectorAll<HTMLElement>(
      `[${MONTH_OBSERVATION_ATTRIBUTE}], [${YEAR_OBSERVATION_ATTRIBUTE}]`,
    )) {
      observer.observe(target);
    }

    return () => observer.disconnect();
  }, [onMonthsObserved, onYearTotalsObserved]);

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

  return {
    scrollRef,
    scrollToCurrentMonth,
  };
};
