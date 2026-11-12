"use client";

import { useCallback, useState, type RefCallback, type RefObject } from "react";

type ChartSize = Readonly<{ width: number; height: number; renderedWidth: number }>;

export const chartSize = (
  contentWidth: number,
  desktopHeight: number,
  compactViewport: boolean,
  coarsePointer: boolean,
): ChartSize => {
  const compact = compactViewport || (coarsePointer && contentWidth < 900);
  const width = compact ? Math.round(contentWidth) : 900;
  const height = compact && width < 768
    ? Math.max(260, Math.round(width * 3 / 4))
    : Math.round(width * desktopHeight / 900);
  return { width, height, renderedWidth: contentWidth };
};

/** Keep desktop geometry, but render narrow charts in actual CSS pixels. */
export const useChartSize = (
  ref: RefObject<HTMLDivElement | null>,
  desktopHeight: number,
): ChartSize & Readonly<{ chartRef: RefCallback<HTMLDivElement> }> => {
  const [size, setSize] = useState<ChartSize>({ width: 900, height: desktopHeight, renderedWidth: 900 });

  // Empty and populated views mount different wrappers; follow the attached node.
  const chartRef = useCallback((element: HTMLDivElement | null) => {
    ref.current = element;
    if (element === null) return;
    const compact = window.matchMedia("(max-width: 1099px)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    let contentWidth = 0;
    const updateSize = (): void => {
      if (contentWidth <= 0) return;
      const next = chartSize(contentWidth, desktopHeight, compact.matches, coarsePointer.matches);
      setSize((current) => current.width === next.width && current.height === next.height && current.renderedWidth === next.renderedWidth
        ? current
        : next);
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      contentWidth = entry.contentRect.width;
      updateSize();
    });
    observer.observe(element);
    compact.addEventListener("change", updateSize);
    coarsePointer.addEventListener("change", updateSize);
    return () => {
      observer.disconnect();
      compact.removeEventListener("change", updateSize);
      coarsePointer.removeEventListener("change", updateSize);
      ref.current = null;
    };
  }, [ref, desktopHeight]);

  return { ...size, chartRef };
};
