"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { buildLiveDataUrl, fetchLiveData } from "@/lib/liveDataFetch";
import { getMonthEndDate } from "@/lib/monthUtils";
import type { FxBreakdownRow, FxBreakdownResult } from "@/server/budget/getFxBreakdown";
import { useFormat } from "@/ui/FormatProvider";
import alertStyles from "@/ui/Alert.module.css";

import { formatFxAmount } from "@/ui/tables/fx/format";
import { formatAmount } from "@/ui/tables/shared/format";
import panelStyles from "@/ui/tables/shared/TablePanel.module.css";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import { buildFxBreakdownSubtitle, sumFxAdjustReport } from "./FxBreakdownPanel.logic";

type Props = Readonly<{
  month: string;
  reportingCurrency: string;
  refreshToken: string;
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
  const { month, reportingCurrency, refreshToken, onClose } = props;
  const { numberFormat } = useFormat();

  const [rows, setRows] = useState<ReadonlyArray<FxBreakdownRow>>([]);
  const [closeValuationDate, setCloseValuationDate] = useState<string>(getMonthEndDate(month));
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
    setCloseValuationDate(getMonthEndDate(month));

    const params = new URLSearchParams({ month });
    fetchLiveData(buildLiveDataUrl("/api/fx-breakdown", params, refreshToken))
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${response.status}: ${text}`);
        }
        return response.json() as Promise<FxBreakdownResult>;
      })
      .then((result) => {
        setRows(result.rows);
        setCloseValuationDate(result.closeValuationDate);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [month, refreshToken]);

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

  const totalFxAdjust = sumFxAdjustReport(rows);

  return (
    <>
      <div className={panelStyles.overlayBackdrop} onClick={closePanel} />
      <div className={panelStyles.sidePanel} ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={cn(panelStyles.panelResizeHandle, isDragging ? panelStyles.panelResizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className={panelStyles.panelHeader}>
          <div>
            <div className={panelStyles.panelTitle}>FX Breakdown</div>
            <div className={panelStyles.panelSubtitle}>{buildFxBreakdownSubtitle(month, closeValuationDate)}</div>
          </div>
          <button className={panelStyles.panelCloseButton} type="button" onClick={closePanel}>
            &times;
          </button>
        </div>

        {error !== null && (
          <div className={alertStyles.alert} style={{ margin: "8px 16px" }}>
            <strong>Failed to load FX breakdown</strong>
            <span>{error}</span>
          </div>
        )}

        <div className={panelStyles.panelBody}>
          <table className={tableStyles.table}>
            <thead>
              <tr>
                <th className={tableStyles.headCell}>Currency</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Open</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Rate</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>{`Open ${reportingCurrency}`}</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>{`Flow ${reportingCurrency}`}</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Close</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>Rate</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>{`Close ${reportingCurrency}`}</th>
                <th className={cn(tableStyles.headCell, tableStyles.headCellRight)}>{`FX ${reportingCurrency}`}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.currency} className={tableStyles.row}>
                  <td className={cn(tableStyles.cell, tableStyles.cellMono)}>{row.currency}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatNative(row.openNative)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatRate(row.openRate)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(row.openReport, numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(row.flowReport, numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatNative(row.closeNative)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatRate(row.closeRate)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(row.closeReport, numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight, row.fxAdjustReport < 0 ? tableStateStyles.over : "")}>{formatFxAmount(row.fxAdjustReport, numberFormat)}</td>
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
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(rows.reduce((s, r) => s + r.openReport, 0), numberFormat)}</td>
                  <td className={tableStyles.cell} />
                  <td className={tableStyles.cell} />
                  <td className={tableStyles.cell} />
                  <td className={cn(tableStyles.cell, tableStyles.cellRight)}>{formatAmount(rows.reduce((s, r) => s + r.closeReport, 0), numberFormat)}</td>
                  <td className={cn(tableStyles.cell, tableStyles.cellRight, totalFxAdjust < 0 ? tableStateStyles.over : "")}>{formatFxAmount(totalFxAdjust, numberFormat)}</td>
                </tr>
              </tfoot>
            )}
          </table>

          {loading && (
            <span className={tableStateStyles.loadingEdge}>Loading</span>
          )}
        </div>
      </div>
    </>
  );
};
