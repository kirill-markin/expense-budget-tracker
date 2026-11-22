"use client";

import { max, scaleBand, scaleLinear } from "d3";
import { useCallback, useState, type CSSProperties, type FocusEvent, type MouseEvent, type ReactElement, type RefCallback } from "react";

import type { NewReturningBucket } from "@/server/reports/newReturning";
import type { ReportPeriod } from "@/server/reports/period";
import { formatBucketTitle, formatCount } from "@/ui/bucketFormat";

import styles from "./NewReturningBarChart.module.css";

type Props = Readonly<{
  title: string;
  period: ReportPeriod;
  buckets: ReadonlyArray<NewReturningBucket>;
}>;

type Tooltip = Readonly<{
  index: number;
  /** Bar center in CSS pixels from the chart's left edge. */
  centerX: number;
  flip: boolean;
}>;

/** Width before the first measurement; the SVG scales to the card until then. */
const INITIAL_WIDTH = 600;
const HEIGHT = 240;
const MARGIN_TOP = 12;
const MARGIN_RIGHT = 8;
const MARGIN_BOTTOM = 28;
const FONT_SIZE = 11;
/** Monospace glyphs are about 0.6em wide. */
const CHAR_WIDTH = FONT_SIZE * 0.6;
const AXIS_GAP = 8;
const LABEL_GAP = 12;
const Y_TICK_COUNT = 4;
const SEGMENT_GAP = 1;

const X_LABEL_LENGTH: Readonly<Record<ReportPeriod, number>> = { day: 10, week: 10, month: 7 };

const formatXLabel = (period: ReportPeriod, bucketStart: string): string =>
  period === "month" ? bucketStart.slice(0, 7) : bucketStart;

const tooltipStyle = (centerX: number): CSSProperties & Readonly<Record<"--bar-x", string>> => ({
  "--bar-x": `${centerX}px`,
});

const describeBucket = (period: ReportPeriod, bucket: NewReturningBucket): string =>
  `${formatBucketTitle(period, bucket)} UTC${bucket.inProgress ? " · in progress" : ""}`;

/** Follows the attached node's width, as apps/web/src/ui/charts/useChartSize.ts does, in actual CSS pixels. */
const useContainerWidth = (): Readonly<{ width: number; containerRef: RefCallback<HTMLDivElement> }> => {
  const [width, setWidth] = useState<number>(INITIAL_WIDTH);
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined || entry.contentRect.width <= 0) return;
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { width, containerRef };
};

export const NewReturningBarChart = (props: Props): ReactElement => {
  const { title, period, buckets } = props;
  const { width, containerRef } = useContainerWidth();
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const peak = max(buckets, (bucket: NewReturningBucket): number => bucket.newCount + bucket.returningCount) ?? 0;
  const y = scaleLinear().domain([0, Math.max(1, peak)]).nice().range([HEIGHT - MARGIN_BOTTOM, MARGIN_TOP]);
  const yTicks = y.ticks(Y_TICK_COUNT).filter(Number.isInteger);
  const yLabelChars = Math.max(...yTicks.map((tick: number): number => formatCount(tick).length));
  const marginLeft = Math.ceil(yLabelChars * CHAR_WIDTH) + AXIS_GAP * 2;

  const x = scaleBand<string>()
    .domain(buckets.map((bucket: NewReturningBucket): string => bucket.bucketStart))
    .range([marginLeft, width - MARGIN_RIGHT])
    .paddingInner(0.15)
    .paddingOuter(0.05);
  const labelWidth = X_LABEL_LENGTH[period] * CHAR_WIDTH;
  const labelEvery = Math.max(1, Math.ceil((labelWidth + LABEL_GAP) / x.step()));
  // Edge labels shift inward so they never leave the SVG.
  const labelCenter = (barCenter: number): number =>
    Math.min(Math.max(barCenter, labelWidth / 2), width - labelWidth / 2);
  const baseline = y(0);

  const showTooltip = (index: number, target: SVGRectElement): void => {
    const wrap = target.ownerSVGElement?.parentElement;
    if (wrap === null || wrap === undefined) {
      throw new Error(`${title} chart bar ${index} is not inside its chart wrapper`);
    }
    const wrapRect = wrap.getBoundingClientRect();
    const barRect = target.getBoundingClientRect();
    const centerX = barRect.left + barRect.width / 2 - wrapRect.left;
    setTooltip({ index, centerX, flip: centerX > wrapRect.width / 2 });
  };
  const hideTooltip = (): void => setTooltip(null);
  const hovered = tooltip === null ? undefined : buckets[tooltip.index];
  const empty = peak === 0;

  return (
    <div className={styles.chart}>
      <div className={styles.legend} aria-hidden="true">
        <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.newSwatch}`} />New</span>
        <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.returningSwatch}`} />Returning</span>
      </div>
      <div ref={containerRef} className={styles.plot}>
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="group"
          aria-label={`${title}: unique people per ${period}, new and returning`}
          onMouseLeave={hideTooltip}
        >
          {yTicks.map((tick: number) => (
            <g key={`y-${tick}`}>
              <line
                x1={marginLeft}
                x2={width - MARGIN_RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                stroke={tick === 0 ? "var(--grid-line-strong)" : "var(--grid-line)"}
              />
              <text
                x={marginLeft - AXIS_GAP}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fill="var(--muted)"
                fontSize={FONT_SIZE}
              >
                {formatCount(tick)}
              </text>
            </g>
          ))}

          {empty && (
            <text
              x={(marginLeft + width - MARGIN_RIGHT) / 2}
              y={(MARGIN_TOP + baseline) / 2}
              textAnchor="middle"
              fill="var(--muted)"
              fontSize={FONT_SIZE + 2}
              pointerEvents="none"
            >
              No people in this range.
            </text>
          )}

          {buckets.map((bucket: NewReturningBucket, index: number) => {
            const barX = x(bucket.bucketStart);
            if (barX === undefined) throw new Error(`${title} chart has no band for ${bucket.bucketStart}`);
            const returningTop = y(bucket.returningCount);
            const gap = bucket.returningCount > 0 && bucket.newCount > 0 ? SEGMENT_GAP : 0;
            const newTop = y(bucket.returningCount + bucket.newCount);
            const fadeClass = bucket.inProgress ? styles.inProgress : undefined;
            return (
              <g key={bucket.bucketStart} data-testid="new-returning-bar">
                <rect
                  className={fadeClass}
                  x={barX}
                  y={returningTop}
                  width={x.bandwidth()}
                  height={baseline - returningTop}
                  fill="var(--accent)"
                />
                <rect
                  className={fadeClass}
                  x={barX}
                  y={newTop}
                  width={x.bandwidth()}
                  height={Math.max(0, returningTop - newTop - gap)}
                  fill="var(--muted)"
                />
                {index % labelEvery === 0 && (
                  <text
                    x={labelCenter(barX + x.bandwidth() / 2)}
                    y={baseline + AXIS_GAP + FONT_SIZE}
                    textAnchor="middle"
                    fill="var(--muted)"
                    fontSize={FONT_SIZE}
                  >
                    {formatXLabel(period, bucket.bucketStart)}
                  </text>
                )}
                <rect
                  className={styles.hit}
                  x={barX - (x.step() - x.bandwidth()) / 2}
                  y={MARGIN_TOP}
                  width={x.step()}
                  height={baseline - MARGIN_TOP}
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={`${describeBucket(period, bucket)}. New: ${formatCount(bucket.newCount)}; returning: ${formatCount(bucket.returningCount)}; total: ${formatCount(bucket.newCount + bucket.returningCount)}.`}
                  data-testid="new-returning-bar-hit"
                  onMouseEnter={(event: MouseEvent<SVGRectElement>): void => showTooltip(index, event.currentTarget)}
                  onFocus={(event: FocusEvent<SVGRectElement>): void => showTooltip(index, event.currentTarget)}
                  onBlur={hideTooltip}
                />
              </g>
            );
          })}
        </svg>

        {tooltip !== null && hovered !== undefined && (
          <div
            className={`${styles.tooltip} ${tooltip.flip ? styles.tooltipFlipped : ""}`}
            style={tooltipStyle(tooltip.centerX)}
            aria-hidden="true"
            data-testid="new-returning-tooltip"
          >
            <div className={styles.tooltipTitle}>{describeBucket(period, hovered)}</div>
            <div className={styles.tooltipRow}>
              <span className={`${styles.swatch} ${styles.newSwatch}`} />
              <span>New</span>
              <span className={styles.tooltipValue}>{formatCount(hovered.newCount)}</span>
            </div>
            <div className={styles.tooltipRow}>
              <span className={`${styles.swatch} ${styles.returningSwatch}`} />
              <span>Returning</span>
              <span className={styles.tooltipValue}>{formatCount(hovered.returningCount)}</span>
            </div>
            <div className={`${styles.tooltipRow} ${styles.tooltipTotal}`}>
              <span>Total</span>
              <span className={styles.tooltipValue}>{formatCount(hovered.newCount + hovered.returningCount)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
