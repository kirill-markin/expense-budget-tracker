import assert from "node:assert/strict";
import test from "node:test";

import { formatFxAmount } from "./budgetTableLogic";
import { buildFxBreakdownSubtitle, sumFxAdjustReport } from "./FxBreakdownPanel.logic";

test("fx breakdown subtitle shows the latest FX date for open months", () => {
  assert.equal(buildFxBreakdownSubtitle("2026-03", "2026-03-28"), "2026-03 · FX as of 2026-03-28");
  assert.equal(buildFxBreakdownSubtitle("2026-02", "2026-02-28"), "2026-02");
});

test("fx breakdown total uses the same FX adjust sign convention as the budget row", () => {
  const total = sumFxAdjustReport([
    { fxAdjustReport: -100.4 },
    { fxAdjustReport: 20.2 },
  ]);

  assert.equal(total, -80.2);
  assert.equal(formatFxAmount(total, "1,234.56"), "+80");
});
