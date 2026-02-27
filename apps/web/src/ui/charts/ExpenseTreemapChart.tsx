"use client";

import { hierarchy, scaleOrdinal, schemeTableau10, treemap } from "d3";
import type { HierarchyRectangularNode } from "d3";
import type { ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { isCategoryVisible } from "@/lib/dataMask";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

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

const WIDTH = 900;
const HEIGHT = 600;
const HEADER_H = 18;
const PAD_TOP = HEADER_H + 6;

const fmtTotal = (value: number, currency: string): string =>
  `${Math.round(value).toLocaleString("en-US")} ${currency}`;

const fmtAmount = (value: number): string =>
  Math.round(value).toLocaleString("en-US");

const fmtCurrency = (amount: number, currency: string): string =>
  `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

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
): TreemapDatum => {
  const groups = new Map<string, Array<LedgerEntry>>();

  for (const entry of entries) {
    if (entry.amountUsd === null) continue;
    const cat = entry.category ?? "Uncategorized";
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
        .sort((a, b) => Math.abs(b.amountUsd ?? 0) - Math.abs(a.amountUsd ?? 0))
        .map((e): TreemapDatum => ({
          name: e.counterparty ?? "",
          category: cat,
          counterparty: e.counterparty,
          leafValue: Math.abs(e.amountUsd ?? 0),
          entry: e,
        })),
    })),
  };
};

export const ExpenseTreemapChart = (props: Props): ReactElement => {
  const { entries, allowlist, reportingCurrency, onCellClick } = props;
  const masked = allowlist !== null && allowlist.size === 0;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const { categoryNodes, colorScale, grandTotal } = useMemo(() => {
    const data = buildHierarchy(entries, allowlist);
    const categories = (data.children ?? []).map((c) => c.name);
    const cs = scaleOrdinal<string, string>().domain(categories).range(schemeTableau10);

    const root = hierarchy(data)
      .sum((d) => d.leafValue ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const layout = treemap<TreemapDatum>()
      .size([WIDTH, HEIGHT])
      .paddingTop(PAD_TOP)
      .paddingInner(2)
      .paddingOuter(3);

    layout(root as unknown as RectNode);

    let total = 0;
    for (const e of entries) {
      if (e.amountUsd === null) continue;
      const cat = e.category ?? "Uncategorized";
      if (allowlist !== null && !isCategoryVisible(allowlist, cat)) continue;
      total += Math.abs(e.amountUsd);
    }

    const rn = root as unknown as RectNode;
    return { categoryNodes: rn.children ?? [], colorScale: cs, grandTotal: total };
  }, [entries, allowlist]);

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
      <div className="treemap-wrap">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Expense treemap">
          <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle" fill="#898989" fontSize={14}>
            No spend data for the selected period.
          </text>
        </svg>
      </div>
    );
  }

  return (
    <>
      {!masked && (
        <div className="treemap-total">
          {fmtTotal(grandTotal, reportingCurrency)}
        </div>
      )}

      <div ref={wrapRef} className={`treemap-wrap${masked ? " data-masked" : ""}`}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Expense treemap">
          {!masked && categoryNodes.map((catNode, ci) => {
            const catName = catNode.data.name;
            const color = colorScale(catName);
            const cw = catNode.x1 - catNode.x0;
            const ch = catNode.y1 - catNode.y0;
            const catTotal = catNode.value ?? 0;
            const clipId = `tm-clip-${ci}`;
            const showHeader = cw > 40 && ch > PAD_TOP;

            const headerText = `${catName} — ${fmtTotal(catTotal, reportingCurrency)}`;
            const headerLabel = estTextW(headerText, 11) < cw - 8 ? headerText : catName;

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
                    const fs = cellFontSize(lw, lh);
                    const amt = fmtAmount(val);
                    const amtFits = estTextW(amt, fs) < lw - 6 && fs + 4 < lh;
                    const cp = leaf.data.counterparty;
                    const cpFits = amtFits && lh > fs + 18 && lw > 40
                      && cp !== null && estTextW(cp, 9) < lw - 6;

                    return (
                      <g
                        key={`${catName}-${li}`}
                        style={{ cursor: "pointer" }}
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
                          <text x={lx + 3} y={ly + fs + 2} fill="#222" fontSize={fs} fontWeight="500">
                            {amt}
                          </text>
                        )}
                        {cpFits && (
                          <text x={lx + 3} y={ly + fs + 14} fill="#555" fontSize={9}>
                            {cp}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Category header — on top of children, with opaque background */}
                  {showHeader && (
                    <g
                      style={{ cursor: "pointer" }}
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
                      <text x={catNode.x0 + 4} y={catNode.y0 + 13} fill="#111" fontSize={11} fontWeight="700">
                        {headerLabel}
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
            className="treemap-tooltip"
            style={{
              left: `${hover.pxLeft}px`,
              top: `${hover.pxTop}px`,
              transform: `translate(${hover.flipLeft ? "calc(-100% - 8px)" : "8px"}, ${hover.flipUp ? "calc(-100% - 8px)" : "8px"})`,
            }}
          >
            <div className="treemap-tooltip-amount">
              {fmtCurrency(Math.abs(hover.entry.amount), hover.entry.currency)}
            </div>
            {hover.entry.amountUsd !== null && hover.entry.currency !== reportingCurrency && (
              <div className="treemap-tooltip-converted">
                ≈ {fmtCurrency(Math.abs(hover.entry.amountUsd), reportingCurrency)}
              </div>
            )}
            {hover.entry.counterparty !== null && (
              <div className="treemap-tooltip-row">{hover.entry.counterparty}</div>
            )}
            <div className="treemap-tooltip-row treemap-tooltip-muted">
              {hover.entry.category ?? "Uncategorized"} · {fmtDate(hover.entry.ts)}
            </div>
            {hover.entry.note !== null && (
              <div className="treemap-tooltip-row treemap-tooltip-muted">{hover.entry.note}</div>
            )}
          </div>
        )}
      </div>
    </>
  );
};
