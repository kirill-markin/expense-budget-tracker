"use client";

import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";

type VisibilityMode = "real" | "filtered";

type FilteredModeContextValue = Readonly<{
  visibilityMode: VisibilityMode;
  setVisibilityMode: (mode: VisibilityMode) => void;
  allowedCategories: ReadonlySet<string>;
  setAllowedCategories: (cats: ReadonlySet<string>) => void;
  effectiveAllowlist: ReadonlySet<string> | null;
  allCategories: ReadonlyArray<string>;
}>;

const STORAGE_MODE_KEY = "expense-tracker-visibility-mode";
const STORAGE_CATS_KEY = "expense-tracker-allowed-categories";

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

  const [allowedCategories, setAllowedCategoriesState] = useState<ReadonlySet<string>>(() => {
    if (typeof window === "undefined") return new Set();
    const stored = localStorage.getItem(STORAGE_CATS_KEY);
    if (stored !== null) {
      try {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set(parsed as ReadonlyArray<string>);
      } catch {
        // ignore
      }
    }
    return new Set();
  });

  const [allCategories, setAllCategories] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    fetch("/api/categories")
      .then((res) => {
        if (!res.ok) throw new Error(`Categories API: ${res.status}`);
        return res.json() as Promise<{ categories: ReadonlyArray<string> }>;
      })
      .then((data) => setAllCategories(data.categories))
      .catch((err: unknown) => console.error("Failed to fetch categories:", err));
  }, []);

  const setVisibilityMode = (mode: VisibilityMode): void => {
    setVisibilityModeState(mode);
  };

  const setAllowedCategories = (cats: ReadonlySet<string>): void => {
    setAllowedCategoriesState(cats);
  };

  useEffect(() => {
    if (isDemoMode) return;
    localStorage.setItem(STORAGE_MODE_KEY, visibilityMode);
  }, [visibilityMode, isDemoMode]);

  useEffect(() => {
    localStorage.setItem(STORAGE_CATS_KEY, JSON.stringify([...allowedCategories]));
  }, [allowedCategories]);

  const effectiveAllowlist: ReadonlySet<string> | null =
    !isDemoMode && visibilityMode === "filtered" ? allowedCategories : null;

  const value: FilteredModeContextValue = {
    visibilityMode: isDemoMode ? "real" : visibilityMode,
    setVisibilityMode,
    allowedCategories,
    setAllowedCategories,
    effectiveAllowlist,
    allCategories,
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
