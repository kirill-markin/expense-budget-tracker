import assert from "node:assert/strict";
import test from "node:test";

import type { SaveBudgetPlanParams } from "@/server/budget/saveBudgetPlan";

type SaveCall = Readonly<{
  userId: string;
  workspaceId: string;
  params: SaveBudgetPlanParams;
}>;

test("filling to year-end with zero clears every remaining month", async (t): Promise<void> => {
  const calls: Array<SaveCall> = [];

  t.mock.module("@/server/budget/saveBudgetPlan", {
    namedExports: {
      saveBudgetPlan: async (
        userId: string,
        workspaceId: string,
        params: SaveBudgetPlanParams,
      ): Promise<void> => {
        calls.push({ userId, workspaceId, params });
      },
    },
  });

  const { fillBudgetBase } = await import("@/server/budget/fillBudgetBase");
  const monthsFilled = await fillBudgetBase("user-1", "workspace-1", {
    fromMonth: "2026-09",
    direction: "spend",
    category: "Groceries",
    baseValue: 0,
  });

  assert.equal(monthsFilled, 3);
  assert.deepEqual(calls.map((call): string => call.params.month), ["2026-10", "2026-11", "2026-12"]);
  for (const call of calls) {
    assert.equal(call.userId, "user-1");
    assert.equal(call.workspaceId, "workspace-1");
    assert.equal(call.params.plannedValue, 0);
    assert.equal(call.params.kind, "base");
    assert.equal(call.params.direction, "spend");
    assert.equal(call.params.category, "Groceries");
  }
});
