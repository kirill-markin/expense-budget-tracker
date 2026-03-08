"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { FxBreakdownRow, FxBreakdownResult } from "@/server/budget/getFxBreakdown";
import { useFormat } from "@/ui/FormatProvider";
import alertStyles from "@/ui/Alert.module.css";

import { formatAmount } from "./format";
import budgetStyles from "./BudgetTable.module.css";
import tableStyles from "./TableUi.module.css";

type Props = Readonly<{
  month: string;
  onClose: () => void;
}>;

const formatRate = (value: number): string => {
  if (value === 0) return "—";
  if (value === 1) return "1";
  return value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
};

const formatNative = (value: number): string => {
  if (value === 0) return "0";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const FxBreakdownPanel = (props: Props): ReactElement => {
  const { month, onClose } = props;
  const { numberFormat } = useFormat();

  const [rows, setRows] = useState<ReadonlyArray<FxBreakdownRow>>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const newWidth = window.innerWidth - e.clientX;
      const clamped = Math.max(320, Math.min(newWidth, window.innerWidth * 0.95));
      setPanelWidth(clamped);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/api/fx-breakdown?month=${encodeURIComponent(month)}`)
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${response.status}: ${text}`);
        }
        return response.json() as Promise<FxBreakdownResult>;
      })
      .then((result) => {
        setRows(result.rows);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [month]);

  const closePanel = useCallback((): void => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel]);

  const totalChange = rows.reduce((sum, r) => sum + r.changeUsd, 0);

  return (
    <>
      <div className={tableStyles.overlayBackdrop} onClick={closePanel} />
      <div className={tableStyles.sidePanel} ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={cn(tableStyles.panelResizeHandle, isDragging ? tableStyles.panelResizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className={tableStyles.panelHeader}>
          <div>
            <div className={tableStyles.panelTitle}>FX Breakdown</div>
            <div className={tableStyles.panelSubtitle}>{month}</div>
          </div>
          <button className={tableStyles.panelCloseButton} type="button" onClick={closePanel}>
            &times;
          </button>
        </div>

        {error !== null && (
          <div className={alertStyles.alert} style={{ margin: "8px 16px" }}>
            <strong>Failed to load FX breakdown</strong>
            <span>{error}</span>
          </div>
        )}

        <div className={tableStyles.panelBody}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.headCell}>Currency</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Open</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Rate</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Open USD</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Delta</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Close</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Rate</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Close USD</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Change USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.currency} className={tableStyles.row}>
                  <td className={cn(tableStyles.cell, tableStyles.cellMono)}>{row.currency}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatNative(row.openNative)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatRate(row.openRate)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(row.openUsd, numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatNative(row.deltaNative)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatNative(row.closeNative)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatRate(row.closeRate)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(row.closeUsd, numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight, row.changeUsd < 0 ? budgetStyles.over : "")}>{formatAmount(row.changeUsd, numberFormat)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className={tableStyles.cell} colSpan={9} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No data for this month.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className={tableStyles.row} style={{ fontWeight: 600 }}>
                  <td className={tableStyles.cell}>Total</td>
                  <td className={tableStyles.cell} />
                  <td className={tableStyles.cell} />
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(rows.reduce((s, r) => s + r.openUsd, 0), numberFormat)}</td>
                  <td className={tableStyles.cell} />
                  <td className={tableStyles.cell} />
                  <td className={tableStyles.cell} />
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(rows.reduce((s, r) => s + r.closeUsd, 0), numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight, totalChange < 0 ? budgetStyles.over : "")}>{formatAmount(totalChange, numberFormat)}</td>
                </tr>
              </tfoot>
            )}
          </table>

          {loading && (
            <span className={budgetStyles.loadingEdge}>Loading</span>
          )}
        </div>
      </div>
    </>
  );
};
