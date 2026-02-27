"use client";

import { hierarchy, scaleOrdinal, schemeTableau10, treemap } from "d3";
import type { HierarchyRectangularNode } from "d3";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

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
const CATEGORY_HEADER_H = 18;
const CATEGORY_PADDING_TOP = CATEGORY_HEADER_H + 4;

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

const estimateTextWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * 0.62;

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
        })),
    })),
  };
};

const sumActiveTotal = (
  entries: ReadonlyArray<LedgerEntry>,
  allowlist: ReadonlySet<string> | null,
  disabled: ReadonlySet<string>,
): number => {
  let total = 0;
  for (const e of entries) {
    if (e.amountUsd === null) continue;
    const cat = e.category ?? "Uncategorized";
    if (allowlist !== null && !isCategoryVisible(allowlist, cat)) continue;
    if (disabled.has(cat)) continue;
    total += Math.abs(e.amountUsd);
  }
  return total;
};

export const ExpenseTreemapChart = (props: Props): ReactElement => {
  const { entries, allowlist, reportingCurrency } = props;
  const masked = allowlist !== null && allowlist.size === 0;
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set());

  const { categoryNodes, colorScale } = useMemo(() => {
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

    layout(root as unknown as RectNode);

    const rn = root as unknown as RectNode;
    return { categoryNodes: rn.children ?? [], colorScale: cs };
  }, [entries, allowlist]);

  const activeTotal = useMemo(
    () => sumActiveTotal(entries, allowlist, disabled),
    [entries, allowlist, disabled],
  );

  const handleCategoryClick = useCallback((catName: string): void => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(catName)) {
        next.delete(catName);
      } else {
        next.add(catName);
      }
      return next;
    });
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
          {formatTotal(activeTotal, reportingCurrency)}
        </div>
      )}

      <div className={`treemap-wrap${masked ? " data-masked" : ""}`}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Expense treemap">
          {!masked && categoryNodes.map((catNode, ci) => {
            const catName = catNode.data.name;
            const color = colorScale(catName);
            const cw = catNode.x1 - catNode.x0;
            const ch = catNode.y1 - catNode.y0;
            const catTotal = catNode.value ?? 0;
            const isDisabled = disabled.has(catName);
            const clipId = `tm-clip-${ci}`;
            const showHeader = cw > 40 && ch > CATEGORY_PADDING_TOP;

            const headerText = `${catName} — ${formatTotal(catTotal, reportingCurrency)}`;
            const headerFits = estimateTextWidth(headerText, 11) < cw - 8;
            const headerLabel = headerFits ? headerText : catName;

            return (
              <g
                key={catName}
                opacity={isDisabled ? 0.2 : 1}
                style={{ cursor: "pointer" }}
                onClick={() => handleCategoryClick(catName)}
              >
                <defs>
                  <clipPath id={clipId}>
                    <rect x={catNode.x0} y={catNode.y0} width={cw} height={ch} />
                  </clipPath>
                </defs>

                <g clipPath={`url(#${clipId})`}>
                  {/* Category background fills entire area */}
                  <rect
                    x={catNode.x0}
                    y={catNode.y0}
                    width={cw}
                    height={ch}
                    fill={lightenColor(color, 0.88)}
                    stroke={lightenColor(color, 0.5)}
                    strokeWidth={1}
                  />

                  {/* Transaction sub-rectangles (rendered in padding-excluded zone) */}
                  {(catNode.children ?? []).map((leaf, li) => {
                    const lx = leaf.x0;
                    const ly = leaf.y0;
                    const lw = leaf.x1 - leaf.x0;
                    const lh = leaf.y1 - leaf.y0;
                    const val = leaf.value ?? 0;
                    const fontSize = computeFontSize(lw, lh);
                    const amountStr = formatAmount(val);
                    const amountFits = estimateTextWidth(amountStr, fontSize) < lw - 6
                      && fontSize + 4 < lh;
                    const cpFits = amountFits
                      && lh > fontSize + 18
                      && lw > 40
                      && leaf.data.counterparty !== null
                      && estimateTextWidth(leaf.data.counterparty ?? "", 9) < lw - 6;

                    return (
                      <g key={`${catName}-${li}`}>
                        <rect
                          x={lx}
                          y={ly}
                          width={lw}
                          height={lh}
                          fill={lightenColor(color, 0.72)}
                          stroke={lightenColor(color, 0.45)}
                          strokeWidth={0.5}
                        />
                        {amountFits && (
                          <text
                            x={lx + 3}
                            y={ly + fontSize + 2}
                            fill="#222"
                            fontSize={fontSize}
                            fontWeight="500"
                          >
                            {amountStr}
                          </text>
                        )}
                        {cpFits && (
                          <text
                            x={lx + 3}
                            y={ly + fontSize + 14}
                            fill="#555"
                            fontSize={9}
                          >
                            {leaf.data.counterparty}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Category header — rendered LAST so it draws on top of children */}
                  {showHeader && (
                    <>
                      <rect
                        x={catNode.x0}
                        y={catNode.y0}
                        width={cw}
                        height={CATEGORY_HEADER_H}
                        fill={lightenColor(color, 0.75)}
                      />
                      <text
                        x={catNode.x0 + 4}
                        y={catNode.y0 + 13}
                        fill="#111"
                        fontSize={11}
                        fontWeight="700"
                      >
                        {headerLabel}
                      </text>
                    </>
                  )}
                </g>
              </g>
            );
          })}
        </svg>
      </div>
    </>
  );
};
