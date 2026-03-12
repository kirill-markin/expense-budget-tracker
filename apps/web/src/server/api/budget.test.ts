import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "./errors";
import { parseBudgetCommentQuery, parseBudgetGridQuery, parseBudgetPlanBody, parseBudgetPlanFillBody, parseBudgetMonthRangeQuery, parseFxBreakdownQuery } from "./budget";

test("parseBudgetPlanBody validates the standard budget plan payload", () => {
  const result = parseBudgetPlanBody({
    month: "2026-03",
    direction: "income",
    category: "Salary",
    kind: "base",
    plannedValue: 123,
  });

  assert.deepEqual(result, {
    month: "2026-03",
    direction: "income",
    category: "Salary",
    kind: "base",
    plannedValue: 123,
  });
});

test("parseBudgetPlanFillBody rejects December as fromMonth", () => {
  assert.throws(
    (): void => {
      parseBudgetPlanFillBody({
        fromMonth: "2026-12",
        direction: "income",
        category: "Salary",
        baseValue: 1,
      });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Cannot fill from December — no following months in the same year",
  );
});

test("parseBudgetCommentQuery validates month direction and category", () => {
  const result = parseBudgetCommentQuery(new URLSearchParams("month=2026-03&direction=spend&category=Rent"));

  assert.deepEqual(result, { month: "2026-03", direction: "spend", category: "Rent" });
});

test("parseBudgetMonthRangeQuery rejects inverted ranges", () => {
  assert.throws(
    (): void => {
      parseBudgetMonthRangeQuery(new URLSearchParams("monthFrom=2026-04&monthTo=2026-03"));
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "monthFrom must be <= monthTo",
  );
});

test("parseBudgetGridQuery requires all params", () => {
  assert.throws(
    (): void => {
      parseBudgetGridQuery(new URLSearchParams("monthFrom=2026-01"));
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Missing required query params: monthFrom, monthTo, planFrom, actualTo",
  );
});

test("parseFxBreakdownQuery requires month", () => {
  assert.throws(
    (): void => {
      parseFxBreakdownQuery(new URLSearchParams());
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Missing required query param: month",
  );
});
