"use client";

import { useCallback, useRef, useState } from "react";

import {
  BUDGET_PLANS_MODE_COOKIE,
  BUDGET_PLANS_MODE_QUERY_PARAM,
  getBudgetPlansModeQueryValue,
  getBudgetPlansModeValue,
  type BudgetPlansMode,
} from "@/ui/tables/budget/budgetTableLogic";

const COOKIE_MAX_AGE_SECONDS = 31536000;

export type BudgetPlansModeState = Readonly<{
  plansMode: BudgetPlansMode;
  setPlansMode: (plansMode: BudgetPlansMode) => void;
}>;

/**
 * Holds the budget table display mode.
 *
 * The page resolves the mode on the server from the query parameter and the
 * cookie, so the first client render matches the markup and no mode flip or
 * second fetch happens on load. Switching stores the new mode in the cookie
 * and rewrites the URL through a history replace, so nothing navigates,
 * reloads or scrolls and the table keeps its mounted state.
 */
export const useBudgetPlansMode = (
  initialPlansMode: BudgetPlansMode,
): BudgetPlansModeState => {
  const [plansMode, setPlansModeState] = useState<BudgetPlansMode>(initialPlansMode);
  const plansModeRef = useRef<BudgetPlansMode>(plansMode);
  plansModeRef.current = plansMode;

  const setPlansMode = useCallback((nextPlansMode: BudgetPlansMode): void => {
    if (nextPlansMode === plansModeRef.current) {
      return;
    }
    setPlansModeState(nextPlansMode);
    document.cookie = `${BUDGET_PLANS_MODE_COOKIE}=${getBudgetPlansModeValue(nextPlansMode)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
    const url = new URL(window.location.href);
    const nextQueryValue = getBudgetPlansModeQueryValue(nextPlansMode);
    if (nextQueryValue === null) {
      url.searchParams.delete(BUDGET_PLANS_MODE_QUERY_PARAM);
    } else {
      url.searchParams.set(BUDGET_PLANS_MODE_QUERY_PARAM, nextQueryValue);
    }
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return { plansMode, setPlansMode };
};
