import type { ReactElement, RefObject } from "react";

export type ColumnDef<T> = Readonly<{
  key: string;
  header: string;
  renderCell: (row: T, rowIndex: number) => ReactElement;
  rightAlign: boolean;
  sortKey: string | null;
}>;

export type SortState = Readonly<{
  key: string;
  dir: "asc" | "desc";
}>;

export type DataTableProps<T> = Readonly<{
  columns: ReadonlyArray<ColumnDef<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T, index: number) => string;
  sort: SortState | null;
  onSort: ((sortKey: string) => void) | null;
  emptyMessage: string;
  loading: boolean;
  loadingMore: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
}>;

export type PageResult<T> = Readonly<{
  items: ReadonlyArray<T>;
  total: number;
}>;

export type InfiniteScrollState<T> = Readonly<{
  rows: ReadonlyArray<T>;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  sentinelRef: RefObject<HTMLDivElement | null>;
  setRows: React.Dispatch<React.SetStateAction<ReadonlyArray<T>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}>;
