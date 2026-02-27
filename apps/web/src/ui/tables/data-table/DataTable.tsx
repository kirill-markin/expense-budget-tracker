import { type ReactElement } from "react";

import { sortIndicator } from "../format";
import type { DataTableProps, SortEntry } from "./types";

const findSortEntry = (sort: ReadonlyArray<SortEntry> | null, sortKey: string | null): { entry: SortEntry; position: number } | null => {
  if (sort === null || sortKey === null) return null;
  const idx = sort.findIndex((s) => s.key === sortKey);
  if (idx === -1) return null;
  return { entry: sort[idx], position: idx + 1 };
};

export const DataTable = <T,>(props: DataTableProps<T>): ReactElement => {
  const { columns, rows, rowKey, sort, onSort, emptyMessage, loading, loadingMore, sentinelRef, footerRows, rowClassName } = props;

  return (
    <>
      <table className="txn-table">
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = col.sortKey !== null && onSort !== null;
              const found = findSortEntry(sort, col.sortKey);
              return (
                <th
                  key={col.key}
                  className={`txn-th${sortable ? " txn-th-sortable" : ""}${col.rightAlign ? " txn-th-right" : ""}`}
                  onClick={sortable ? () => onSort(col.sortKey!) : undefined}
                >
                  {col.header}{found !== null ? sortIndicator(true, found.entry.dir, found.position) : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={rowKey(row, idx)} className={rowClassName !== undefined ? rowClassName(row, idx) : "txn-row"}>
              {columns.map((col) => col.renderCell(row, idx))}
            </tr>
          ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td className="txn-cell" colSpan={columns.length} style={{ textAlign: "center", color: "var(--muted)" }}>
                {emptyMessage}
              </td>
            </tr>
          )}
          {footerRows !== undefined && footerRows}
        </tbody>
      </table>

      {sentinelRef !== null && (
        <div ref={sentinelRef} className="txn-scroll-sentinel">
          {loading && <span className="loading-indicator">Loading<span className="loading-dots" /></span>}
          {loadingMore && <span className="loading-indicator">Loading more<span className="loading-dots" /></span>}
        </div>
      )}
    </>
  );
};
