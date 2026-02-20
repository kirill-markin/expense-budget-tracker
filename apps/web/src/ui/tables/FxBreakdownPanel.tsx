"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FxBreakdownRow, FxBreakdownResult } from "@/server/budget/getFxBreakdown";

type Props = Readonly<{
  month: string;
  onClose: () => void;
}>;

const formatAmount = (value: number): string => {
  if (value === 0) return "0";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

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
      <div className="drilldown-overlay" onClick={closePanel} />
      <div className="drilldown-panel" ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={`drilldown-resize-handle${isDragging ? " dragging" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className="drilldown-header">
          <div>
            <div className="drilldown-title">FX Breakdown</div>
            <div className="drilldown-subtitle">{month}</div>
          </div>
          <button className="drilldown-close" type="button" onClick={closePanel}>
            &times;
          </button>
        </div>

        {error !== null && (
          <div className="budget-alert" style={{ margin: "8px 16px" }}>
            <strong>Failed to load FX breakdown</strong>
            <span>{error}</span>
          </div>
        )}

        <div className="drilldown-body">
          <table className="txn-table">
            <thead>
              <tr>
                <th className="txn-th">Currency</th>
                <th className="txn-th txn-th-right">Open</th>
                <th className="txn-th txn-th-right">Rate</th>
                <th className="txn-th txn-th-right">Open USD</th>
                <th className="txn-th txn-th-right">Delta</th>
                <th className="txn-th txn-th-right">Close</th>
                <th className="txn-th txn-th-right">Rate</th>
                <th className="txn-th txn-th-right">Close USD</th>
                <th className="txn-th txn-th-right">Change USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.currency} className="txn-row">
                  <td className="txn-cell txn-cell-mono">{row.currency}</td>
                  <td className="txn-cell txn-cell-right">{formatNative(row.openNative)}</td>
                  <td className="txn-cell txn-cell-right">{formatRate(row.openRate)}</td>
                  <td className="txn-cell txn-cell-right">{formatAmount(row.openUsd)}</td>
                  <td className="txn-cell txn-cell-right">{formatNative(row.deltaNative)}</td>
                  <td className="txn-cell txn-cell-right">{formatNative(row.closeNative)}</td>
                  <td className="txn-cell txn-cell-right">{formatRate(row.closeRate)}</td>
                  <td className="txn-cell txn-cell-right">{formatAmount(row.closeUsd)}</td>
                  <td className={`txn-cell txn-cell-right${row.changeUsd < 0 ? " budget-over" : ""}`}>{formatAmount(row.changeUsd)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="txn-cell" colSpan={9} style={{ textAlign: "center", color: "var(--muted)" }}>
                    No data for this month.
                  </td>
                </tr>
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="txn-row" style={{ fontWeight: 600 }}>
                  <td className="txn-cell">Total</td>
                  <td className="txn-cell" />
                  <td className="txn-cell" />
                  <td className="txn-cell txn-cell-right">{formatAmount(rows.reduce((s, r) => s + r.openUsd, 0))}</td>
                  <td className="txn-cell" />
                  <td className="txn-cell" />
                  <td className="txn-cell" />
                  <td className="txn-cell txn-cell-right">{formatAmount(rows.reduce((s, r) => s + r.closeUsd, 0))}</td>
                  <td className={`txn-cell txn-cell-right${totalChange < 0 ? " budget-over" : ""}`}>{formatAmount(totalChange)}</td>
                </tr>
              </tfoot>
            )}
          </table>

          {loading && (
            <span className="loading-indicator">Loading<span className="loading-dots" /></span>
          )}
        </div>
      </div>
    </>
  );
};
