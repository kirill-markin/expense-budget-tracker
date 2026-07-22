import assert from "node:assert/strict";
import test from "node:test";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { parseBudgetAdjustmentCreateBody, parseBudgetAdjustmentId, parseBudgetAdjustmentPatchBody, parseBudgetPlanBody } from "@/server/api/budget";
import { ApiRouteError } from "@/server/api/errors";

const SAFE_INTEGER_MESSAGE = /JavaScript-safe integer between -9007199254740991 and 9007199254740991, inclusive/;
const ADJUSTMENT_ID = "6d09f70d-c767-4a43-9ab7-89559af99c41";

const assertBadRequest = (run: () => unknown, message: RegExp): void => {
  assert.throws(
    run,
    (error: unknown): boolean => {
      assert.ok(error instanceof ApiRouteError);
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, message);
      return true;
    },
  );
};

test("budget adjustment create accepts zero, signed integers, and nullable notes", (): void => {
  const month = getCurrentMonth();

  assert.deepEqual(parseBudgetAdjustmentCreateBody({
    adjustmentId: ADJUSTMENT_ID,
    month,
    direction: "spend",
    category: "Groceries",
    amount: 0,
    note: null,
  }), {
    adjustmentId: ADJUSTMENT_ID,
    month,
    direction: "spend",
    category: "Groceries",
    amount: 0,
    note: null,
  });

  assert.equal(parseBudgetAdjustmentCreateBody({
    adjustmentId: ADJUSTMENT_ID,
    month,
    direction: "income",
    category: "Bonus",
    amount: -125,
    note: "Correction",
  }).amount, -125);

  assert.equal(parseBudgetAdjustmentCreateBody({
    adjustmentId: ADJUSTMENT_ID,
    month,
    direction: "income",
    category: "Maximum boundary",
    amount: Number.MAX_SAFE_INTEGER,
    note: null,
  }).amount, Number.MAX_SAFE_INTEGER);
  assert.equal(parseBudgetAdjustmentCreateBody({
    adjustmentId: ADJUSTMENT_ID,
    month,
    direction: "spend",
    category: "Minimum boundary",
    amount: Number.MIN_SAFE_INTEGER,
    note: null,
  }).amount, Number.MIN_SAFE_INTEGER);
});

test("budget adjustment category and note limits count Unicode code points", (): void => {
  const category = "\u{1F600}".repeat(200);
  const note = "\u{1F680}".repeat(2000);
  const valid = {
    adjustmentId: ADJUSTMENT_ID,
    month: getCurrentMonth(),
    direction: "spend",
    category,
    amount: 0,
    note,
  } as const;

  assert.deepEqual(parseBudgetAdjustmentCreateBody(valid), valid);
  assert.deepEqual(parseBudgetAdjustmentPatchBody({ category, note }), { category, note });
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, category: "\u{1F600}".repeat(201) }),
    /max 200 chars/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, note: "\u{1F680}".repeat(2001) }),
    /max 2000 chars/,
  );
});

test("budget adjustment create rejects past months, non-integers, and unknown fields", (): void => {
  const valid = {
    adjustmentId: ADJUSTMENT_ID,
    month: getCurrentMonth(),
    direction: "spend",
    category: "Groceries",
    amount: 10,
    note: null,
  } as const;

  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, adjustmentId: "not-a-uuid" }),
    /Expected UUID/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, month: offsetMonth(valid.month, -1) }),
    /current or future month/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, amount: 10.5 }),
    SAFE_INTEGER_MESSAGE,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, amount: Number.MAX_SAFE_INTEGER + 1 }),
    SAFE_INTEGER_MESSAGE,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, amount: Number.MIN_SAFE_INTEGER - 1 }),
    SAFE_INTEGER_MESSAGE,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, category: "" }),
    /non-empty string/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, workspaceId: "workspace-1" }),
    /Unrecognized key/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentCreateBody({ ...valid, origin: "legacy" }),
    /Unrecognized key/,
  );
});

test("budget adjustment patch accepts only editable fields and allows edits without a month", (): void => {
  assert.deepEqual(parseBudgetAdjustmentPatchBody({ amount: -25 }), { amount: -25 });
  assert.deepEqual(parseBudgetAdjustmentPatchBody({ note: null }), { note: null });
  assert.deepEqual(parseBudgetAdjustmentPatchBody({
    month: offsetMonth(getCurrentMonth(), 1),
    category: "Dining",
  }), {
    month: offsetMonth(getCurrentMonth(), 1),
    category: "Dining",
  });

  assertBadRequest(() => parseBudgetAdjustmentPatchBody({}), /at least one editable field/);
  assertBadRequest(
    () => parseBudgetAdjustmentPatchBody({ month: offsetMonth(getCurrentMonth(), -1) }),
    /current or future month/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentPatchBody({ direction: "income" }),
    /Unrecognized key/,
  );
  assertBadRequest(
    () => parseBudgetAdjustmentPatchBody({ amount: 1, adjustmentId: "adjustment-1" }),
    /Unrecognized key/,
  );
});

test("budget adjustment notes and ids are bounded", (): void => {
  assert.equal(parseBudgetAdjustmentId("a".repeat(200)).length, 200);
  assertBadRequest(() => parseBudgetAdjustmentId(""), /non-empty string/);
  assertBadRequest(() => parseBudgetAdjustmentId("a".repeat(201)), /max 200 chars/);
  assertBadRequest(
    () => parseBudgetAdjustmentPatchBody({ note: "n".repeat(2001) }),
    /max 2000 chars/,
  );
});

test("budget plan accepts Base and rejects Modifier", (): void => {
  const body = {
    month: getCurrentMonth(),
    direction: "spend",
    category: "Groceries",
    plannedValue: 400,
  } as const;

  assert.equal(parseBudgetPlanBody({ ...body, kind: "base" }).kind, "base");
  assertBadRequest(() => parseBudgetPlanBody({ ...body, kind: "modifier" }), /Expected 'base'/);
});
