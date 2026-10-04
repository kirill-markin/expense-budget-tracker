"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BudgetAdjustment } from "@/server/budget/budgetAdjustments";
import {
  createBudgetAdjustment,
  deleteBudgetAdjustment,
  fetchBudgetRange,
  patchBudgetAdjustment,
} from "@/ui/tables/budget/budgetTableApi";
import {
  createBudgetAdjustmentRowsController,
  type BudgetAdjustmentRowsController,
  type BudgetAdjustmentRowsControllerRuntime,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import {
  getBudgetPlanFrom,
  type BudgetPlansMode,
} from "@/ui/tables/budget/budgetTableLogic";

const AUTOSAVE_DELAY_MS = 600;

type UseBudgetAdjustmentRowsControllerParams = Readonly<{
  adjustments: ReadonlyArray<BudgetAdjustment>;
  /** First month whose adjustments the editor may change. */
  planFrom: string;
  actualTo: string;
  currentMonth: string;
  /**
   * Mode whose plan window every budget-grid range read must cover. The
   * caller resolves it from the requested and the loaded mode, so a read that
   * lands while a switch is pending is valid for both layouts.
   */
  rangePlansMode: BudgetPlansMode;
  refreshToken: string;
  invalidateYears: (years: ReadonlySet<string>) => void;
}>;

export const useBudgetAdjustmentRowsController = ({
  adjustments,
  planFrom,
  actualTo,
  currentMonth,
  rangePlansMode,
  refreshToken,
  invalidateYears,
}: UseBudgetAdjustmentRowsControllerParams): BudgetAdjustmentRowsController => {
  const currentRequestRef = useRef({
    actualTo,
    currentMonth,
    rangePlansMode,
    refreshToken,
    invalidateYears,
  });
  currentRequestRef.current = {
    actualTo,
    currentMonth,
    rangePlansMode,
    refreshToken,
    invalidateYears,
  };
  const runtimeRef = useRef<BudgetAdjustmentRowsControllerRuntime | null>(null);

  if (runtimeRef.current === null) {
    runtimeRef.current = createBudgetAdjustmentRowsController({
      initialAdjustments: adjustments,
      planFrom,
      autosaveDelayMs: AUTOSAVE_DELAY_MS,
      createAdjustment: (params) => createBudgetAdjustment(params),
      patchAdjustment: (adjustmentId, params) =>
        patchBudgetAdjustment(adjustmentId, params),
      deleteAdjustment: (adjustmentId) => deleteBudgetAdjustment(adjustmentId),
      fetchRange: (monthFrom, monthTo, signal) => {
        const current = currentRequestRef.current;
        // Every budget-grid read of this table goes through here, so the plan
        // window follows the resolved range mode on all of them.
        return fetchBudgetRange(
          monthFrom,
          monthTo,
          getBudgetPlanFrom(current.rangePlansMode, monthFrom, current.currentMonth),
          current.actualTo,
          current.refreshToken,
          signal,
        );
      },
      generateAdjustmentId: (): string => crypto.randomUUID(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancelScheduled: (handle) => clearTimeout(handle),
      invalidateYears: (years) => currentRequestRef.current.invalidateYears(years),
    });
  }

  const runtime = runtimeRef.current;
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );

  useEffect(() => {
    runtime.activate();
    return (): void => runtime.dispose();
  }, [runtime]);

  return { ...state, ...runtime.commands };
};
