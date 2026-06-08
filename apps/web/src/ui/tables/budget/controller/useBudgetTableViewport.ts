"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

const SCROLL_THRESHOLD = 200;

type UseBudgetTableViewportParams = Readonly<{
  currentMonth: string;
  pendingSaves: number;
  onReachLeft: () => Promise<void>;
  onReachRight: () => Promise<void>;
}>;

export type BudgetTableViewportState = Readonly<{
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToCurrentMonth: () => void;
}>;

export const useBudgetTableViewport = ({
  currentMonth,
  pendingSaves,
  onReachLeft,
  onReachRight,
}: UseBudgetTableViewportParams): BudgetTableViewportState => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollWidthRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  const markPrependPending = useCallback((): void => {
    if (isPrependingRef.current) {
      return;
    }

    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    prevScrollWidthRef.current = scrollElement.scrollWidth;
    isPrependingRef.current = true;
  }, []);

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
          markPrependPending();
          void onReachLeft();
        }
        if (scrollEnd < SCROLL_THRESHOLD) {
          void onReachRight();
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
  }, [isRtl, markPrependPending, onReachLeft, onReachRight]);

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
