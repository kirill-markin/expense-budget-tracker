import { randomUUID } from "node:crypto";

import { getCurrentMonth } from "@/lib/monthUtils";
import { BudgetAdjustmentNotFoundError, type BudgetAdjustment, type CreateBudgetAdjustmentParams, type PatchBudgetAdjustmentParams } from "@/server/budget/budgetAdjustments";
import { getDemoBudgetAdjustments } from "@/server/demo/data";

const DEMO_CREATED_ID_PATTERN = /^demo-created-(income|spend)-[0-9a-f-]{36}$/;

const getCreatedDemoDirection = (adjustmentId: string): "income" | "spend" | null => {
  const match = DEMO_CREATED_ID_PATTERN.exec(adjustmentId);
  if (match === null) {
    return null;
  }
  return match[1] as "income" | "spend";
};

export const createDemoBudgetAdjustment = (
  params: CreateBudgetAdjustmentParams,
): BudgetAdjustment => {
  const timestamp = new Date().toISOString();
  return {
    adjustmentId: `demo-created-${params.direction}-${randomUUID()}`,
    month: params.month,
    direction: params.direction,
    category: params.category,
    amount: params.amount,
    note: params.note,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

export const patchDemoBudgetAdjustment = (
  adjustmentId: string,
  params: PatchBudgetAdjustmentParams,
): BudgetAdjustment => {
  const existing = getDemoBudgetAdjustments().find((adjustment) =>
    adjustment.adjustmentId === adjustmentId);
  const createdDirection = getCreatedDemoDirection(adjustmentId);
  if (existing === undefined && createdDirection === null) {
    throw new BudgetAdjustmentNotFoundError(adjustmentId);
  }

  const timestamp = new Date().toISOString();
  return {
    adjustmentId,
    month: params.month ?? existing?.month ?? getCurrentMonth(),
    direction: existing?.direction ?? createdDirection as "income" | "spend",
    category: params.category ?? existing?.category ?? "Demo adjustment",
    amount: params.amount ?? existing?.amount ?? 0,
    note: params.note !== undefined ? params.note : existing?.note ?? null,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
};

export const deleteDemoBudgetAdjustment = (adjustmentId: string): void => {
  const exists = getDemoBudgetAdjustments().some((adjustment) =>
    adjustment.adjustmentId === adjustmentId);
  if (!exists && getCreatedDemoDirection(adjustmentId) === null) {
    throw new BudgetAdjustmentNotFoundError(adjustmentId);
  }
};
