"use client";

import { hierarchy, scaleOrdinal, schemeTableau10, treemap } from "d3";
import type { HierarchyRectangularNode } from "d3";
import type { ReactElement } from "react";
import { useMemo } from "react";

import { isCategoryVisible } from "@/lib/dataMask";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

type Props = Readonly<{
  entries: ReadonlyArray<LedgerEntry>;
  allowlist: ReadonlySet<string> | null;
  reportingCurrency: string;
}>;

type TreemapDatum = {
  readonly name: string;
  readonly category: string | null;
  readonly counterparty: string | null;
  readonly children?: ReadonlyArray<TreemapDatum>;
  readonly leafValue?: number;
};

type RectNode = HierarchyRectangularNode<TreemapDatum>;

const WIDTH = 900;
const HEIGHT = 600;
const CATEGORY_PADDING_TOP = 20;
const MIN_LABEL_WIDTH = 32;
const MIN_LABEL_HEIGHT = 14;

const formatTotal = (value: number, currency: string): string =>
  `${Math.round(value).toLocaleString("en-US")} ${currency}`;

const formatAmount = (value: number): string =>
  Math.round(value).toLocaleString("en-US");

const lightenColor = (hex: string, factor: number): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * factor);
  const lg = Math.round(g + (255 - g) * factor);
  const lb = Math.round(b + (255 - b) * factor);
  return `rgb(${lr},${lg},${lb})`;
};

const computeFontSize = (w: number, h: number): number => {
  const area = w * h;
  return Math.min(Math.max(Math.sqrt(area) / 4, 9), 32);
};

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

  const children: ReadonlyArray<TreemapDatum> = Array.from(groups.entries())
    .map(([cat, catEntries]) => ({
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
        })),
    }))
    .sort((a, b) => {
      const totalA = a.children?.reduce((s, c) => s + (c.leafValue ?? 0), 0) ?? 0;
      const totalB = b.children?.reduce((s, c) => s + (c.leafValue ?? 0), 0) ?? 0;
      return totalB - totalA;
    });

  return { name: "root", category: null, counterparty: null, children };
};

export const ExpenseTreemapChart = (props: Props): ReactElement => {
  const { entries, allowlist, reportingCurrency } = props;
  const masked = allowlist !== null && allowlist.size === 0;

  const { categoryNodes, colorScale, grandTotal } = useMemo(() => {
    const data = buildHierarchy(entries, allowlist);
    const categories = (data.children ?? []).map((c) => c.name);
    const cs = scaleOrdinal<string, string>().domain(categories).range(schemeTableau10);

    const root = hierarchy(data)
      .sum((d) => d.leafValue ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    const layout = treemap<TreemapDatum>()
      .size([WIDTH, HEIGHT])
      .paddingTop(CATEGORY_PADDING_TOP)
      .paddingInner(2)
      .paddingOuter(3);

    layout(root as unknown as HierarchyRectangularNode<TreemapDatum>);

    const total = entries.reduce((sum, e) => {
      if (e.amountUsd === null) return sum;
      const cat = e.category ?? "Uncategorized";
      if (allowlist !== null && !isCategoryVisible(allowlist, cat)) return sum;
      return sum + Math.abs(e.amountUsd);
    }, 0);

    const rn = root as unknown as RectNode;
    return { categoryNodes: rn.children ?? [], colorScale: cs, grandTotal: total };
  }, [entries, allowlist]);

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
          {formatTotal(grandTotal, reportingCurrency)}
        </div>
      )}

      <div className={`treemap-wrap${masked ? " data-masked" : ""}`}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Expense treemap">
          {!masked && categoryNodes.map((catNode, ci) => {
            const color = colorScale(catNode.data.name);
            const cw = catNode.x1 - catNode.x0;
            const ch = catNode.y1 - catNode.y0;
            const catTotal = catNode.value ?? 0;
            const clipId = `treemap-clip-${ci}`;

            return (
              <g key={catNode.data.name}>
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
                    fill={lightenColor(color, 0.88)}
                    stroke={lightenColor(color, 0.55)}
                    strokeWidth={1}
                  />

                  {/* Category header label */}
                  {cw > 50 && ch > CATEGORY_PADDING_TOP && (
                    <text
                      x={catNode.x0 + 4}
                      y={catNode.y0 + 14}
                      fill="#333"
                      fontSize={11}
                      fontWeight="600"
                    >
                      {catNode.data.name} — {formatTotal(catTotal, reportingCurrency)}
                    </text>
                  )}

                  {/* Transaction sub-rectangles */}
                  {(catNode.children ?? []).map((leaf, li) => {
                    const lw = leaf.x1 - leaf.x0;
                    const lh = leaf.y1 - leaf.y0;
                    const val = leaf.value ?? 0;
                    const fontSize = computeFontSize(lw, lh);
                    const showAmount = lw > MIN_LABEL_WIDTH && lh > MIN_LABEL_HEIGHT;
                    const showCounterparty = lh > 30 && lw > 50 && leaf.data.counterparty !== null;

                    return (
                      <g key={`${catNode.data.name}-${li}`}>
                        <rect
                          x={leaf.x0}
                          y={leaf.y0}
                          width={lw}
                          height={lh}
                          fill={lightenColor(color, 0.72)}
                          stroke={lightenColor(color, 0.5)}
                          strokeWidth={0.5}
                        />
                        {showAmount && (
                          <text
                            x={leaf.x0 + 3}
                            y={leaf.y0 + fontSize + 2}
                            fill="#222"
                            fontSize={fontSize}
                            fontWeight="500"
                          >
                            {formatAmount(val)}
                          </text>
                        )}
                        {showCounterparty && (
                          <text
                            x={leaf.x0 + 3}
                            y={leaf.y0 + fontSize + 14}
                            fill="#666"
                            fontSize={9}
                          >
                            {leaf.data.counterparty}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
};
