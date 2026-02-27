"use client";

import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

type VisibilityMode = "real" | "filtered";

type FilteredModeContextValue = Readonly<{
  visibilityMode: VisibilityMode;
  setVisibilityMode: (mode: VisibilityMode) => void;
  allowedCategories: ReadonlySet<string>;
  effectiveAllowlist: ReadonlySet<string> | null;
  allCategories: ReadonlyArray<string>;
  categoriesLoading: boolean;
}>;

const STORAGE_MODE_KEY = "expense-tracker-visibility-mode";

const FilteredModeContext = createContext<FilteredModeContextValue | null>(null);

type ProviderProps = Readonly<{
  isDemoMode: boolean;
  children: ReactNode;
}>;

export const FilteredModeProvider = (props: ProviderProps): ReactElement => {
  const { isDemoMode, children } = props;

  const [visibilityMode, setVisibilityModeState] = useState<VisibilityMode>(() => {
    if (isDemoMode) return "real";
    if (typeof window === "undefined") return "real";
    const stored = localStorage.getItem(STORAGE_MODE_KEY);
    if (stored === "filtered") return "filtered";
    return "real";
  });

  const [allowedCategories, setAllowedCategories] = useState<ReadonlySet<string>>(new Set());
  const [allCategories, setAllCategories] = useState<ReadonlyArray<string>>([]);
  const [categoriesLoading, setCategoriesLoading] = useState<boolean>(true);

  useEffect(() => {
    fetch("/api/categories")
      .then((res) => {
        if (!res.ok) throw new Error(`Categories API: ${res.status}`);
        return res.json() as Promise<{ categories: ReadonlyArray<string> }>;
      })
      .then((data) => setAllCategories(data.categories))
      .catch((err: unknown) => console.error("Failed to fetch categories:", err));
  }, []);

  useEffect(() => {
    fetch("/api/workspace-settings")
      .then((res) => {
        if (!res.ok) throw new Error(`Workspace settings API: ${res.status}`);
        return res.json() as Promise<{ filteredCategories: ReadonlyArray<string> | null }>;
      })
      .then((data) => {
        if (data.filteredCategories !== null) {
          setAllowedCategories(new Set(data.filteredCategories));
        }
      })
      .catch((err: unknown) => console.error("Failed to fetch filtered categories:", err))
      .finally(() => setCategoriesLoading(false));
  }, []);

  const setVisibilityMode = (mode: VisibilityMode): void => {
    setVisibilityModeState(mode);
  };

  useEffect(() => {
    if (isDemoMode) return;
    localStorage.setItem(STORAGE_MODE_KEY, visibilityMode);
  }, [visibilityMode, isDemoMode]);

  const effectiveAllowlist: ReadonlySet<string> | null =
    !isDemoMode && visibilityMode === "filtered" ? allowedCategories : null;

  const value: FilteredModeContextValue = {
    visibilityMode: isDemoMode ? "real" : visibilityMode,
    setVisibilityMode,
    allowedCategories,
    effectiveAllowlist,
    allCategories,
    categoriesLoading,
  };

  return (
    <FilteredModeContext.Provider value={value}>
      {children}
    </FilteredModeContext.Provider>
  );
};

export const useFilteredMode = (): FilteredModeContextValue => {
  const ctx = useContext(FilteredModeContext);
  if (ctx === null) {
    throw new Error("useFilteredMode must be used within a FilteredModeProvider");
  }
  return ctx;
};
