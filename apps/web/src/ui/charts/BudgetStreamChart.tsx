"use client";

import { area, curveMonotoneX, max, scaleLinear, scaleOrdinal, scaleTime, schemeTableau10, stack } from "d3";
import type { ReactElement } from "react";
import { useMemo, useRef, useState } from "react";

import type { MaskLevel } from "@/lib/dataMask";
import { isDirectionVisible, isCategoryVisible } from "@/lib/dataMask";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";

type Props = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  maskLevel: MaskLevel;
  reportingCurrency: string;
}>;

type MonthRecord = { readonly date: Date; readonly [key: string]: number | Date };

type StackLayer = ReadonlyArray<readonly [number, number] & { readonly data: MonthRecord }>;

type HoverInfo = Readonly<{
  monthLabel: string;
  svgX: number;
  pxLeft: number;
  flipLeft: boolean;
  incomeItems: ReadonlyArray<Readonly<{ category: string; value: number; color: string }>>;
  spendItems: ReadonlyArray<Readonly<{ category: string; value: number; color: string }>>;
  incomeTotal: number;
  spendTotal: number;
  hasUnconvertible: boolean;
}>;

const parseMonthToDate = (month: string): Date => {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month string: ${month}`);
  }
  return date;
};

const collectCategories = (
  rows: ReadonlyArray<BudgetRow>,
  direction: string,
): ReadonlyArray<string> => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.direction === direction && row.actual > 0) {
      totals.set(row.category, (totals.get(row.category) ?? 0) + row.actual);
    }
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);
};

const pivotByMonth = (
  rows: ReadonlyArray<BudgetRow>,
  direction: string,
  categories: ReadonlyArray<string>,
): ReadonlyArray<MonthRecord> => {
  const map = new Map<string, Record<string, number>>();

  for (const row of rows) {
    if (row.direction !== direction) continue;
    if (!categories.includes(row.category)) continue;

    let entry = map.get(row.month);
    if (entry === undefined) {
      entry = {};
      for (const cat of categories) {
        entry[cat] = 0;
      }
      map.set(row.month, entry);
    }
    entry[row.category] = (entry[row.category] ?? 0) + row.actual;
  }

  const months = Array.from(map.keys()).sort();
  return months.map((m) => ({
    date: parseMonthToDate(m),
    ...map.get(m)!,
  }));
};

const formatAmount = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return Math.round(value).toLocaleString("en-US");
};

const formatAmountFull = (value: number): string =>
  Math.round(value).toLocaleString("en-US");

const formatMonthToYYYYMM = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
};

const formatMonth = (date: Date): string => {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = months[date.getUTCMonth()];
  const y = String(date.getUTCFullYear()).slice(2);
  return `${m} '${y}`;
};

const findClosestDateIndex = (
  dates: ReadonlyArray<Date>,
  xScale: (value: Date) => number,
  mouseX: number,
): number => {
  let closest = 0;
  let minDist = Infinity;
  for (let i = 0; i < dates.length; i++) {
    const dist = Math.abs(xScale(dates[i]) - mouseX);
    if (dist < minDist) {
      minDist = dist;
      closest = i;
    }
  }
  return closest;
};

export const BudgetStreamChart = (props: Props): ReactElement => {
  const { rows, maskLevel, reportingCurrency } = props;
  const masked = maskLevel === "hidden";
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const { incomeCategories, spendCategories, incomeData, spendData } = useMemo(() => {
    const ic = isDirectionVisible(maskLevel, "income")
      ? collectCategories(rows, "income")
      : [];
    const sc = isDirectionVisible(maskLevel, "spend")
      ? collectCategories(rows, "spend").filter(
          (cat) => isCategoryVisible(maskLevel, "spend", cat),
        )
      : [];
    const id = ic.length > 0 ? pivotByMonth(rows, "income", ic) : [];
    const sd = sc.length > 0 ? pivotByMonth(rows, "spend", sc) : [];
    return { incomeCategories: ic, spendCategories: sc, incomeData: id, spendData: sd };
  }, [rows, maskLevel]);

  const width = 900;
  const height = 520;
  const margin = { top: 24, right: 24, bottom: 64, left: 64 } as const;

  const allCategories = useMemo(
    () => [...incomeCategories, ...spendCategories],
    [incomeCategories, spendCategories],
  );

  const colorScale = useMemo(
    () => scaleOrdinal<string, string>().domain(allCategories).range(schemeTableau10),
    [allCategories],
  );

  if (incomeData.length === 0 && spendData.length === 0 && !masked) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Budget streamgraph">
        <text x={width / 2} y={height / 2} textAnchor="middle" fill="#898989" fontSize={14}>
          No data for the selected period.
        </text>
      </svg>
    );
  }

  const incomeStacked: ReadonlyArray<StackLayer> = incomeCategories.length > 0 && incomeData.length > 0
    ? (stack<MonthRecord>().keys(incomeCategories as unknown as string[])(incomeData as MonthRecord[]) as unknown as ReadonlyArray<StackLayer>)
    : [];

  const spendStacked: ReadonlyArray<StackLayer> = spendCategories.length > 0 && spendData.length > 0
    ? (stack<MonthRecord>().keys(spendCategories as unknown as string[])(spendData as MonthRecord[]) as unknown as ReadonlyArray<StackLayer>)
    : [];

  const allDates: ReadonlyArray<Date> = [
    ...incomeData.map((d) => d.date),
    ...spendData.map((d) => d.date),
  ].sort((a, b) => a.getTime() - b.getTime());

  const uniqueDates = allDates.filter((d, i, arr) => i === 0 || d.getTime() !== arr[i - 1].getTime());

  const xMin = uniqueDates[0];
  const xMax = uniqueDates[uniqueDates.length - 1];

  const xScale = scaleTime()
    .domain([xMin, xMax])
    .range([margin.left, width - margin.right]);

  const maxIncome = incomeStacked.length > 0
    ? max(incomeStacked[incomeStacked.length - 1], (d) => d[1]) ?? 0
    : 0;

  const maxSpend = spendStacked.length > 0
    ? max(spendStacked[spendStacked.length - 1], (d) => d[1]) ?? 0
    : 0;

  const yExtent = Math.max(maxIncome, maxSpend) * 1.3;

  const yScale = scaleLinear()
    .domain([-yExtent, yExtent])
    .range([height - margin.bottom, margin.top]);

  const incomeAreaGen = area<readonly [number, number] & { readonly data: MonthRecord }>()
    .x((d) => xScale(d.data.date))
    .y0((d) => yScale(d[0]))
    .y1((d) => yScale(d[1]))
    .curve(curveMonotoneX);

  const spendAreaGen = area<readonly [number, number] & { readonly data: MonthRecord }>()
    .x((d) => xScale(d.data.date))
    .y0((d) => yScale(-d[0]))
    .y1((d) => yScale(-d[1]))
    .curve(curveMonotoneX);

  const yTicks = yScale.ticks(8);
  const xTicks = uniqueDates;

  const handleMouseMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (svg === null || wrap === null) return;

    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (ctm === null) return;
    const svgPt = pt.matrixTransform(ctm.inverse());
    const svgX = svgPt.x;

    if (svgX < margin.left || svgX > width - margin.right) {
      setHover(null);
      return;
    }

    const idx = findClosestDateIndex(uniqueDates, (d) => xScale(d), svgX);
    const date = uniqueDates[idx];
    const x = xScale(date);

    const snapPt = svg.createSVGPoint();
    snapPt.x = x;
    snapPt.y = 0;
    const screenPt = snapPt.matrixTransform(ctm);
    const wrapRect = wrap.getBoundingClientRect();
    const pxLeft = screenPt.x - wrapRect.left;
    const flipLeft = pxLeft > wrapRect.width / 2;

    const incomeItems: Array<Readonly<{ category: string; value: number; color: string }>> = [];
    const incomeRecord = incomeData.find((d) => d.date.getTime() === date.getTime());
    if (incomeRecord !== undefined) {
      for (const cat of incomeCategories) {
        const val = incomeRecord[cat];
        if (typeof val === "number" && val > 0) {
          incomeItems.push({ category: cat, value: val, color: colorScale(cat) });
        }
      }
    }

    const spendItems: Array<Readonly<{ category: string; value: number; color: string }>> = [];
    const spendRecord = spendData.find((d) => d.date.getTime() === date.getTime());
    if (spendRecord !== undefined) {
      for (const cat of spendCategories) {
        const val = spendRecord[cat];
        if (typeof val === "number" && val > 0) {
          spendItems.push({ category: cat, value: val, color: colorScale(cat) });
        }
      }
    }

    incomeItems.sort((a, b) => b.value - a.value);
    spendItems.sort((a, b) => b.value - a.value);

    const incomeTotal = incomeItems.reduce((sum, item) => sum + item.value, 0);
    const spendTotal = spendItems.reduce((sum, item) => sum + item.value, 0);

    const monthStr = formatMonthToYYYYMM(date);
    const hasUnconvertible = rows.some((r) => r.month === monthStr && r.hasUnconvertible);

    setHover({
      monthLabel: formatMonth(date),
      svgX: x,
      pxLeft,
      flipLeft,
      incomeItems,
      spendItems,
      incomeTotal,
      spendTotal,
      hasUnconvertible,
    });
  };

  const handleMouseLeave = (): void => {
    setHover(null);
  };

  return (
    <>
      {!masked && (
        <div className="stream-legend">
          {incomeCategories.length > 0 && (
            <>
              <span className="stream-legend-heading">Income:</span>
              {incomeCategories.map((cat) => (
                <span key={`legend-income-${cat}`} className="stream-legend-item">
                  <span className="stream-legend-swatch" style={{ background: colorScale(cat) }} />
                  {cat}
                </span>
              ))}
            </>
          )}
          {spendCategories.length > 0 && (
            <>
              <span className="stream-legend-heading">Spend:</span>
              {spendCategories.map((cat) => (
                <span key={`legend-spend-${cat}`} className="stream-legend-item">
                  <span className="stream-legend-swatch" style={{ background: colorScale(cat) }} />
                  {cat}
                </span>
              ))}
            </>
          )}
        </div>
      )}

      <div ref={wrapRef} className={`stream-chart-wrap${masked ? " data-masked" : ""}`}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Budget streamgraph"
          onMouseMove={!masked ? handleMouseMove : undefined}
          onMouseLeave={!masked ? handleMouseLeave : undefined}
        >
          {!masked && (
          <>
            <defs>
              <clipPath id="stream-plot-clip">
                <rect
                  x={margin.left}
                  y={margin.top}
                  width={width - margin.left - margin.right}
                  height={height - margin.top - margin.bottom}
                />
              </clipPath>
            </defs>

            {yTicks.map((tick) => {
              const y = yScale(tick);
              return (
                <g key={`y-${tick}`}>
                  <line
                    x1={margin.left}
                    x2={width - margin.right}
                    y1={y}
                    y2={y}
                    stroke={tick === 0 ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.08)"}
                    strokeWidth={tick === 0 ? 1.5 : 1}
                  />
                  <text
                    x={margin.left - 10}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill="#898989"
                    fontSize={11}
                  >
                    {formatAmount(tick)}
                  </text>
                </g>
              );
            })}

            {xTicks.map((tick) => {
              const x = xScale(tick);
              return (
                <g key={`x-${tick.toISOString()}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={margin.top}
                    y2={height - margin.bottom}
                    stroke="rgba(0,0,0,0.06)"
                  />
                  <text
                    x={x}
                    y={height - margin.bottom + 18}
                    textAnchor="middle"
                    fill="#898989"
                    fontSize={11}
                  >
                    {formatMonth(tick)}
                  </text>
                </g>
              );
            })}

            <g clipPath="url(#stream-plot-clip)">
              {incomeStacked.map((layer, i) => {
                const key = incomeCategories[i];
                const path = incomeAreaGen(layer as unknown as Array<readonly [number, number] & { readonly data: MonthRecord }>);
                if (path === null) return null;
                return (
                  <path key={`income-${key}`} d={path} fill={colorScale(key)} opacity={0.85} />
                );
              })}

              {spendStacked.map((layer, i) => {
                const key = spendCategories[i];
                const path = spendAreaGen(layer as unknown as Array<readonly [number, number] & { readonly data: MonthRecord }>);
                if (path === null) return null;
                return (
                  <path key={`spend-${key}`} d={path} fill={colorScale(key)} opacity={0.85} />
                );
              })}
            </g>

            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={yScale(0)}
              y2={yScale(0)}
              stroke="rgba(0,0,0,0.4)"
              strokeWidth={1.5}
            />

            <text x={margin.left} y={margin.top - 10} fill="#898989" fontSize={11}>
              {reportingCurrency}
            </text>
            <text x={margin.left} y={yScale(0) - 6} fill="#898989" fontSize={10}>
              Income
            </text>
            <text x={margin.left} y={yScale(0) + 14} fill="#898989" fontSize={10}>
              Spend
            </text>

            {hover !== null && (
              <line
                x1={hover.svgX}
                x2={hover.svgX}
                y1={margin.top}
                y2={height - margin.bottom}
                stroke="rgba(0,0,0,0.4)"
                strokeWidth={1}
                strokeDasharray="4 3"
                pointerEvents="none"
              />
            )}
          </>
        )}
      </svg>

      {hover !== null && !masked && (
        <div
          className="stream-tooltip"
          style={{
            left: `${hover.pxLeft}px`,
            top: 0,
            transform: hover.flipLeft ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="stream-tooltip-title">
            {hover.monthLabel}
            {hover.hasUnconvertible && (
              <span className="stream-tooltip-warn"> *</span>
            )}
          </div>
          {hover.incomeItems.length > 0 && (
            <>
              <div className="stream-tooltip-section">
                Income: {formatAmountFull(hover.incomeTotal)}
              </div>
              {hover.incomeItems.map((item) => (
                <div key={`tip-i-${item.category}`} className="stream-tooltip-row">
                  <span className="stream-legend-swatch" style={{ background: item.color }} />
                  <span>{item.category}</span>
                  <span className="stream-tooltip-value">{formatAmountFull(item.value)}</span>
                </div>
              ))}
            </>
          )}
          {hover.spendItems.length > 0 && (
            <>
              <div className="stream-tooltip-section">
                Spend: {formatAmountFull(hover.spendTotal)}
              </div>
              {hover.spendItems.map((item) => (
                <div key={`tip-s-${item.category}`} className="stream-tooltip-row">
                  <span className="stream-legend-swatch" style={{ background: item.color }} />
                  <span>{item.category}</span>
                  <span className="stream-tooltip-value">{formatAmountFull(item.value)}</span>
                </div>
              ))}
            </>
          )}
          {hover.hasUnconvertible && (
            <div className="stream-tooltip-warn">* some currencies not converted to {reportingCurrency}</div>
          )}
        </div>
      )}
      </div>
    </>
  );
};
