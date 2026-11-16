"use client";

import { hierarchy, scaleOrdinal, schemeTableau10, treemap } from "d3";
import type { HierarchyRectangularNode } from "d3";
import type { ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { NumericText } from "@/ui/NumericText";
import { cn } from "@/lib/cn";
import { isCategoryVisible } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import type { LedgerEntry } from "@/server/transactions/getTransactions";
import { useFormat } from "@/ui/FormatProvider";
import styles from "@/ui/charts/ExpenseTreemapChart.module.css";
import { useChartSize } from "@/ui/charts/useChartSize";
import { formatNumber } from "@/ui/tables/shared/format";

type Props = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  allowlist: ReadonlySet<string> | null;
  reportingCurrency: string;
  onCellClick: (category: string) => void;
}>;

type TreemapDatum = {
  readonly name: string;
  readonly category: string | null;
  readonly counterparty: string | null;
  readonly children?: ReadonlyArray<TreemapDatum>;
  readonly leafValue?: number;
  readonly entry?: LedgerEntry;
};

type RectNode = HierarchyRectangularNode<TreemapDatum>;

type HoverInfo = Readonly<{
  entry: LedgerEntry;
  pxLeft: number;
  pxTop: number;
  flipLeft: boolean;
  flipUp: boolean;
}>;

const HEADER_H = 18;
const PAD_TOP = HEADER_H + 3;

const fmtTotal = (value: number, currency: string, numberFormat: NumberFormat): string =>
  `${formatNumber(Math.round(value), numberFormat, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${currency}`;

const fmtAmount = (value: number, numberFormat: NumberFormat): string =>
  formatNumber(Math.round(value), numberFormat, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtCurrency = (amount: number, currency: string, numberFormat: NumberFormat): string =>
  `${formatNumber(amount, numberFormat, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

const fmtDate = (ts: string): string => {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const lighten = (hex: string, f: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r + (255 - r) * f)},${Math.round(g + (255 - g) * f)},${Math.round(b + (255 - b) * f)})`;
};

const estTextW = (text: string, fontSize: number): number =>
  text.length * fontSize * 0.62;

const cellFontSize = (w: number, h: number): number =>
  Math.min(Math.max(Math.sqrt(w * h) / 4, 9), 32);

const buildHierarchy = (
  entries: ReadonlyArray<LedgerEntry>,
  allowlist: ReadonlySet<string> | null,
  uncategorizedLabel: string,
): TreemapDatum => {
  const groups = new Map<string, Array<LedgerEntry>>();

  for (const entry of entries) {
    if (entry.amountReport === null) continue;
    const cat = entry.category ?? uncategorizedLabel;
    if (allowlist !== null && !isCategoryVisible(allowlist, cat)) continue;
    const existing = groups.get(cat);
    if (existing !== undefined) {
      existing.push(entry);
    } else {
      groups.set(cat, [entry]);
    }
  }

  return {
    name: "root",
    category: null,
    counterparty: null,
    children: Array.from(groups.entries()).map(([cat, catEntries]) => ({
      name: cat,
      category: cat,
      counterparty: null,
      children: catEntries
        .sort((a, b) => Math.abs(b.amountReport ?? 0) - Math.abs(a.amountReport ?? 0))
        .map((e): TreemapDatum => ({
          name: e.counterparty ?? "",
          category: cat,
          counterparty: e.counterparty,
          leafValue: Math.abs(e.amountReport ?? 0),
          entry: e,
        })),
    })),
  };
};

export const ExpenseTreemapChart = (props: Props): ReactElement => {
  const { entries, allowlist, reportingCurrency, onCellClick } = props;
  const { t, i18n } = useTranslation();
  const { numberFormat } = useFormat();
  const masked = allowlist !== null && allowlist.size === 0;
  const wrapRef = useRef<HTMLDivElement>(null);
  const { width, height, chartRef } = useChartSize(wrapRef, 600);
  const compact = width < 900;
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const uncategorizedLabel = t("chart.uncategorized");
  const { categoryNodes, colorScale, grandTotal } = useMemo(() => {
    const data = buildHierarchy(entries, allowlist, uncategorizedLabel);
    const categories = (data.children ?? []).map((c) => c.name);
    const cs = scaleOrdinal<string, string>().domain(categories).range(schemeTableau10);

    const root = hierarchy(data)
      .sum((d) => d.leafValue ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const layout = treemap<TreemapDatum>()
      .size([width, height])
      .paddingOuter(3)
      .paddingInner(2)
      .paddingTop(PAD_TOP);

    layout(root as unknown as RectNode);

    let total = 0;
    for (const e of entries) {
      if (e.amountReport === null) continue;
      const cat = e.category ?? uncategorizedLabel;
      if (allowlist !== null && !isCategoryVisible(allowlist, cat)) continue;
      total += Math.abs(e.amountReport);
    }

    const rn = root as unknown as RectNode;
    return { categoryNodes: rn.children ?? [], colorScale: cs, grandTotal: total };
  }, [entries, allowlist, uncategorizedLabel, width, height]);

  const handleLeafEnter = useCallback((event: React.MouseEvent, entry: LedgerEntry): void => {
    const wrap = wrapRef.current;
    if (wrap === null) return;
    const rect = wrap.getBoundingClientRect();
    const pxLeft = event.clientX - rect.left;
    const pxTop = event.clientY - rect.top;
    setHover({
      entry,
      pxLeft,
      pxTop,
      flipLeft: pxLeft > rect.width * 0.6,
      flipUp: pxTop > rect.height * 0.6,
    });
  }, []);

  const handleLeafLeave = useCallback((): void => {
    setHover(null);
  }, []);

  if (categoryNodes.length === 0 && !masked) {
    return (
      <div ref={chartRef} className={styles.wrap}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Expense treemap">
          <text x={width / 2} y={height / 2} textAnchor="middle" fill="var(--muted)" fontSize={14}>
            {t("chart.noSpendData")}
          </text>
        </svg>
      </div>
    );
  }

  return (
    <>
      {!masked && (
        <div className={styles.total}>
          <NumericText>{fmtTotal(grandTotal, reportingCurrency, numberFormat)}</NumericText>
        </div>
      )}

      <div ref={chartRef} className={cn(styles.wrap, masked ? "data-masked" : "")}>
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Expense treemap">
          {!masked && categoryNodes.map((catNode, ci) => {
            const catName = catNode.data.name;
            const color = colorScale(catName);
            const cw = catNode.x1 - catNode.x0;
            const ch = catNode.y1 - catNode.y0;
            const catTotal = catNode.value ?? 0;
            const clipId = `tm-clip-${ci}`;
            const showHeader = cw > (compact ? 64 : 40) && ch > PAD_TOP;

            const headerText = `${catName} — ${fmtTotal(catTotal, reportingCurrency, numberFormat)}`;
            const showHeaderAmount = estTextW(headerText, 11) < cw - 8;

            return (
              <g key={catName}>
                <defs>
                  <clipPath id={clipId}>
                    <rect x={catNode.x0} y={catNode.y0} width={cw} height={ch} />
                  </clipPath>
                </defs>

                <g clipPath={`url(#${clipId})`}>
                  {/* Category background */}
                  <rect
                    x={catNode.x0}
                    y={catNode.y0}
                    width={cw}
                    height={ch}
                    fill={lighten(color, 0.88)}
                    stroke={lighten(color, 0.5)}
                    strokeWidth={1}
                  />

                  {/* Transaction sub-rectangles */}
                  {(catNode.children ?? []).map((leaf, li) => {
                    const lx = leaf.x0;
                    const ly = leaf.y0;
                    const lw = leaf.x1 - leaf.x0;
                    const lh = leaf.y1 - leaf.y0;
                    const val = leaf.value ?? 0;
                    const fs = compact ? Math.max(11, cellFontSize(lw, lh)) : cellFontSize(lw, lh);
                    const amt = fmtAmount(val, numberFormat);
                    const amtFits = (!compact || (lw >= 48 && lh >= 28))
                      && estTextW(amt, fs) < lw - 6 && fs + 4 < lh;
                    const cp = leaf.data.counterparty;
                    const cpFontSize = compact ? 11 : 9;
                    const cpFits = amtFits && lh > fs + cpFontSize + 9 && lw > 40
                      && cp !== null && estTextW(cp, cpFontSize) < lw - 6;

                    return (
                      <g
                        key={`${catName}-${li}`}
                        style={{ cursor: "var(--cursor-pointer)" }}
                        onClick={(e) => { e.stopPropagation(); onCellClick(catName); }}
                        onMouseEnter={leaf.data.entry !== undefined ? (e) => handleLeafEnter(e, leaf.data.entry as LedgerEntry) : undefined}
                        onMouseLeave={handleLeafLeave}
                      >
                        <rect
                          x={lx}
                          y={ly}
                          width={lw}
                          height={lh}
                          fill={lighten(color, 0.72)}
                          stroke={lighten(color, 0.45)}
                          strokeWidth={0.5}
                        />
                        {amtFits && (
                          <text direction="ltr" unicodeBidi="isolate" textAnchor="start" x={lx + 3} y={ly + fs + 2} fill="var(--treemap-text)" fontSize={fs} fontWeight="500">
                            {amt}
                          </text>
                        )}
                        {cpFits && (
                          <text textAnchor={i18n.dir() === "rtl" ? "end" : "start"} x={lx + 3} y={ly + fs + cpFontSize + 5} fill="var(--treemap-muted)" fontSize={cpFontSize}>
                            {cp}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Category header — on top of children, with opaque background */}
                  {showHeader && (
                    <g
                      style={{ cursor: "var(--cursor-pointer)" }}
                      onClick={() => onCellClick(catName)}
                    >
                      <rect
                        x={catNode.x0}
                        y={catNode.y0}
                        width={cw}
                        height={HEADER_H}
                        fill={lighten(color, 0.6)}
                      />
                      <line
                        x1={catNode.x0}
                        x2={catNode.x1}
                        y1={catNode.y0 + HEADER_H}
                        y2={catNode.y0 + HEADER_H}
                        stroke={lighten(color, 0.35)}
                        strokeWidth={1}
                      />
                      <text textAnchor={i18n.dir() === "rtl" ? "end" : "start"} x={catNode.x0 + 4} y={catNode.y0 + 13} fill="var(--treemap-heading)" fontSize={11} fontWeight="700">
                        {catName}
                        {showHeaderAmount && <> — <tspan direction="ltr" unicodeBidi="isolate">{fmtTotal(catTotal, reportingCurrency, numberFormat)}</tspan></>}
                      </text>
                    </g>
                  )}
                </g>
              </g>
            );
          })}
        </svg>

        {/* Hover tooltip */}
        {hover !== null && (
          <div
            className={styles.tooltip}
            style={{
              left: `${hover.pxLeft}px`,
              top: `${hover.pxTop}px`,
              transform: `translate(${hover.flipLeft ? "calc(-100% - 8px)" : "8px"}, ${hover.flipUp ? "calc(-100% - 8px)" : "8px"})`,
            }}
          >
            <div className={styles.tooltipAmount}>
              <NumericText>{fmtCurrency(Math.abs(hover.entry.amount), hover.entry.currency, numberFormat)}</NumericText>
            </div>
            {hover.entry.amountReport !== null && hover.entry.currency !== reportingCurrency && (
              <div className={styles.tooltipConverted}>
                <NumericText>≈ {fmtCurrency(Math.abs(hover.entry.amountReport), reportingCurrency, numberFormat)}</NumericText>
              </div>
            )}
            {hover.entry.counterparty !== null && (
              <div className={styles.tooltipRow}>{hover.entry.counterparty}</div>
            )}
            <div className={cn(styles.tooltipRow, styles.tooltipMuted)}>
              {hover.entry.category ?? uncategorizedLabel} · {fmtDate(hover.entry.ts)}
            </div>
            {hover.entry.note !== null && (
              <div className={cn(styles.tooltipRow, styles.tooltipMuted, styles.tooltipNote)}>{hover.entry.note}</div>
            )}
          </div>
        )}
      </div>
    </>
  );
};
