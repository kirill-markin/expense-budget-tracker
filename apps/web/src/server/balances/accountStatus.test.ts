import assert from "node:assert/strict";
import test from "node:test";

import { computeAccountStatus } from "@/server/balances/accountStatus";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_TIME_MS = Date.parse("2026-07-17T12:00:00.000Z");

test("computeAccountStatus keeps every non-zero balance active", (): void => {
  assert.equal(computeAccountStatus(1, null, CURRENT_TIME_MS), "active");
  assert.equal(computeAccountStatus(-1, CURRENT_TIME_MS - 365 * DAY_MS, CURRENT_TIME_MS), "active");
});

test("computeAccountStatus marks zero balances without non-transfer operations inactive", (): void => {
  assert.equal(computeAccountStatus(0, null, CURRENT_TIME_MS), "inactive");
});

test("computeAccountStatus keeps zero balances active through exactly 90 days", (): void => {
  assert.equal(
    computeAccountStatus(0, CURRENT_TIME_MS - 90 * DAY_MS, CURRENT_TIME_MS),
    "active",
  );
});

test("computeAccountStatus marks zero balances inactive after 90 days", (): void => {
  assert.equal(
    computeAccountStatus(0, CURRENT_TIME_MS - 90 * DAY_MS - 1, CURRENT_TIME_MS),
    "inactive",
  );
});
