"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import styles from "./TableUi.module.css";

type Props = Readonly<{
  children: ReactNode;
  className?: string;
  stickyFirstColumn?: boolean;
  inPanel?: boolean;
}>;

/** Keeps the end-edge hint outside the scrollport, including in RTL. */
export const HorizontalTableScroll = ({ children, className, stickyFirstColumn = false, inPanel = false }: Props): ReactElement => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollEnd, setCanScrollEnd] = useState(false);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const update = (): void => {
      setCanScrollEnd(scroll.scrollWidth - scroll.clientWidth - Math.abs(scroll.scrollLeft) > 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroll);
    if (scroll.firstElementChild !== null) observer.observe(scroll.firstElementChild);
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", update);
    };
  }, []);

  return (
    <div
      data-bleed
      className={cn(styles.scrollFrame, inPanel ? styles.panelScroll : "", canScrollEnd ? styles.scrollHasMore : "", stickyFirstColumn ? styles.stickyFirstColumn : "", className)}
    >
      <div ref={scrollRef} className={styles.scroll} data-table-scroll>
        {children}
      </div>
    </div>
  );
};
