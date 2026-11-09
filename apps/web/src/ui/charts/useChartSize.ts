"use client";

import { useCallback, useState, type RefCallback, type RefObject } from "react";

type ChartSize = Readonly<{ width: number; height: number; renderedWidth: number }>;

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
    let contentWidth = 0;
    const updateSize = (): void => {
      if (contentWidth <= 0) return;
      const width = compact.matches ? Math.round(contentWidth) : 900;
      const height = compact.matches && width < 768
        ? Math.max(260, Math.round(width * 3 / 4))
        : Math.round(width * desktopHeight / 900);
      setSize((current) => current.width === width && current.height === height && current.renderedWidth === contentWidth
        ? current
        : { width, height, renderedWidth: contentWidth });
    };
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      contentWidth = entry.contentRect.width;
      updateSize();
    });
    observer.observe(element);
    compact.addEventListener("change", updateSize);
    return () => {
      observer.disconnect();
      compact.removeEventListener("change", updateSize);
      ref.current = null;
    };
  }, [ref, desktopHeight]);

  return { ...size, chartRef };
};
