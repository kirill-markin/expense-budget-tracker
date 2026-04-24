import { useCallback, useState } from "react";

import type { SortState } from "./types";

type SortDirection = "asc" | "desc";
type SortMode = "single" | "multi";

type UseTableSortResult = Readonly<{
  sort: SortState;
  onSort: (sortKey: string) => void;
}>;

export const useTableSort = (
  mode: SortMode,
  initialKey: string,
  initialDir: SortDirection,
  defaultDirections: Readonly<Record<string, SortDirection>>,
): UseTableSortResult => {
  const [sort, setSort] = useState<SortState>([{ key: initialKey, dir: initialDir }]);

  const onSort = useCallback((sortKey: string): void => {
    setSort((prev) => {
      const existingIdx = prev.findIndex((s) => s.key === sortKey);

      if (existingIdx !== -1) {
        const existing = prev[existingIdx];
        const toggled = { key: sortKey, dir: (existing.dir === "asc" ? "desc" : "asc") as SortDirection };

        if (mode === "single") {
          return [toggled];
        }
        return prev.map((s, i) => i === existingIdx ? toggled : s);
      }

      const dir = defaultDirections[sortKey] ?? "asc";
      const entry = { key: sortKey, dir };

      if (mode === "single") {
        return [entry];
      }
      return [entry, ...prev];
    });
  }, [mode, defaultDirections]);

  return { sort, onSort };
};
