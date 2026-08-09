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

const AUTOSAVE_DELAY_MS = 600;

type UseBudgetAdjustmentRowsControllerParams = Readonly<{
  adjustments: ReadonlyArray<BudgetAdjustment>;
  planFrom: string;
  actualTo: string;
  refreshToken: string;
  invalidateYears: (years: ReadonlySet<string>) => void;
}>;

export const useBudgetAdjustmentRowsController = ({
  adjustments,
  planFrom,
  actualTo,
  refreshToken,
  invalidateYears,
}: UseBudgetAdjustmentRowsControllerParams): BudgetAdjustmentRowsController => {
  const currentRequestRef = useRef({
    planFrom,
    actualTo,
    refreshToken,
    invalidateYears,
  });
  currentRequestRef.current = {
    planFrom,
    actualTo,
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
        return fetchBudgetRange(
          monthFrom,
          monthTo,
          current.planFrom,
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
