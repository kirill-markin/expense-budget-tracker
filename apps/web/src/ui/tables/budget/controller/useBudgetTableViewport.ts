"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

const HORIZONTAL_PREFETCH_MARGIN = "0px 600px 0px 600px";
const MONTH_OBSERVATION_ATTRIBUTE = "data-budget-month";
const YEAR_OBSERVATION_ATTRIBUTE = "data-budget-year-total";

type UseBudgetTableViewportParams = Readonly<{
  currentMonth: string;
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
  pendingSaves,
  onMonthsObserved,
  onYearTotalsObserved,
}: UseBudgetTableViewportParams): BudgetTableViewportState => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

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
