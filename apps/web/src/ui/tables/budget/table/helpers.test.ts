import assert from "node:assert/strict";
import test from "node:test";

import { isDirectionActualOverPlanned } from "@/ui/tables/budget/table/helpers";

test("isDirectionActualOverPlanned treats a zero plan with spending as overspending", (): void => {
  assert.equal(isDirectionActualOverPlanned("spend", 0, 120), true);
  assert.equal(isDirectionActualOverPlanned("spend", 0, 0), false);
  assert.equal(isDirectionActualOverPlanned("spend", 0, -120), false);
});

test("isDirectionActualOverPlanned compares actual against a positive plan", (): void => {
  assert.equal(isDirectionActualOverPlanned("spend", 100, 101), true);
  assert.equal(isDirectionActualOverPlanned("spend", 100, 100), false);
  assert.equal(isDirectionActualOverPlanned("spend", 100, 99), false);
});

test("isDirectionActualOverPlanned applies only to the spend direction", (): void => {
  assert.equal(isDirectionActualOverPlanned("income", 0, 120), false);
  assert.equal(isDirectionActualOverPlanned("income", 100, 101), false);
  assert.equal(isDirectionActualOverPlanned("transfer", 0, 120), false);
});
