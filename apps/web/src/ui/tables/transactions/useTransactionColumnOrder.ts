import { useSyncExternalStore } from "react";

import type { ColumnDef } from "@/ui/tables/shared/data-table/types";

const query = "(max-width: 1099px)";
const subscribe = (onChange: () => void): (() => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const getSnapshot = (): boolean => window.matchMedia(query).matches;
const getServerSnapshot = (): boolean => false;

/** Keep the narrow sticky Date column first without changing desktop order. */
export const useTransactionColumnOrder = <T,>(columns: ReadonlyArray<ColumnDef<T>>): ReadonlyArray<ColumnDef<T>> => {
  const compact = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (!compact) return columns;
  return [
    ...columns.filter((column) => column.key === "date"),
    ...columns.filter((column) => !["date", "copy", "delete"].includes(column.key)),
    ...columns.filter((column) => column.key === "copy" || column.key === "delete"),
  ];
};
