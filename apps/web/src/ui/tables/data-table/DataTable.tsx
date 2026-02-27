import { type ReactElement } from "react";

import { sortIndicator } from "../format";
import type { DataTableProps } from "./types";

export const DataTable = <T,>(props: DataTableProps<T>): ReactElement => {
  const { columns, rows, rowKey, sort, onSort, emptyMessage, loading, loadingMore, sentinelRef } = props;

  return (
    <>
      <table className="txn-table">
        <thead>
          <tr>
            {columns.map((col) => {
              const sortable = col.sortKey !== null && onSort !== null;
              const active = sort !== null && col.sortKey === sort.key;
              return (
                <th
                  key={col.key}
                  className={`txn-th${sortable ? " txn-th-sortable" : ""}${col.rightAlign ? " txn-th-right" : ""}`}
                  onClick={sortable ? () => onSort(col.sortKey!) : undefined}
                >
                  {col.header}{active ? sortIndicator(true, sort.dir) : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={rowKey(row, idx)} className="txn-row">
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
        </tbody>
      </table>

      <div ref={sentinelRef} className="txn-scroll-sentinel">
        {loading && <span className="loading-indicator">Loading<span className="loading-dots" /></span>}
        {loadingMore && <span className="loading-indicator">Loading more<span className="loading-dots" /></span>}
      </div>
    </>
  );
};
