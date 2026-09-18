import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import {
  DELETE_BUDGET_PLAN_QUERY,
  INSERT_BUDGET_PLAN_QUERY,
  UPDATE_BUDGET_PLAN_QUERY,
  saveBudgetPlanWithQuery,
  type SaveBudgetPlanParams,
} from "@/server/budget/saveBudgetPlan";
import type { QueryFn } from "@/server/db/contextRunner";

const PARAMS: SaveBudgetPlanParams = {
  month: "2026-08",
  direction: "spend",
  category: "Groceries",
  kind: "base",
  plannedValue: 1200,
};

const CELL_PARAMS: ReadonlyArray<unknown> = [
  "workspace-1",
  PARAMS.month,
  PARAMS.direction,
  PARAMS.category,
  PARAMS.kind,
];

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const createQuerySequence = (
  rowCounts: ReadonlyArray<number | null>,
): Readonly<{ queryFn: QueryFn; calls: Array<QueryCall> }> => {
  const calls: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    const rowCount = rowCounts[calls.length];
    if (rowCount === undefined) {
      throw new Error(`Unexpected budget plan test query ${calls.length + 1}`);
    }
    calls.push({ text, params });
    return { rows: [], rowCount, command: "", oid: 0, fields: [] };
  };
  return { queryFn, calls };
};

test("saving a value updates the existing cell and appends nothing", async (): Promise<void> => {
  const sequence = createQuerySequence([1]);

  await saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS);

  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, UPDATE_BUDGET_PLAN_QUERY);
  assert.deepEqual(sequence.calls[0]?.params, [...CELL_PARAMS, PARAMS.plannedValue, "EUR"]);
});

test("saving a value inserts the first cell when the update affects no row", async (): Promise<void> => {
  const sequence = createQuerySequence([0, 1]);

  await saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS);

  assert.equal(sequence.calls.length, 2);
  assert.equal(sequence.calls[0]?.text, UPDATE_BUDGET_PLAN_QUERY);
  assert.equal(sequence.calls[1]?.text, INSERT_BUDGET_PLAN_QUERY);
  assert.deepEqual(sequence.calls[1]?.params, [...CELL_PARAMS, PARAMS.plannedValue, "EUR"]);
});

test("saving zero deletes the cell and writes nothing else", async (): Promise<void> => {
  const sequence = createQuerySequence([1]);

  await saveBudgetPlanWithQuery(
    sequence.queryFn,
    "workspace-1",
    "EUR",
    { ...PARAMS, plannedValue: 0 },
  );

  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, DELETE_BUDGET_PLAN_QUERY);
  assert.deepEqual(sequence.calls[0]?.params, CELL_PARAMS);
});

test("saving zero deletes the cell even when no row exists", async (): Promise<void> => {
  const sequence = createQuerySequence([0]);

  await saveBudgetPlanWithQuery(
    sequence.queryFn,
    "workspace-1",
    "EUR",
    { ...PARAMS, plannedValue: 0 },
  );

  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, DELETE_BUDGET_PLAN_QUERY);
});

test("a missing update row count is an explicit error instead of a silent insert", async (): Promise<void> => {
  const sequence = createQuerySequence([null]);

  await assert.rejects(
    saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS),
    /reported no affected row count for 2026-08 spend Groceries/,
  );
  assert.equal(sequence.calls.length, 1);
});

test("every plan write scopes one cell and avoids ON CONFLICT", (): void => {
  for (const queryText of [
    DELETE_BUDGET_PLAN_QUERY,
    UPDATE_BUDGET_PLAN_QUERY,
    INSERT_BUDGET_PLAN_QUERY,
  ]) {
    assert.doesNotMatch(queryText, /ON CONFLICT/);
  }
  for (const queryText of [DELETE_BUDGET_PLAN_QUERY, UPDATE_BUDGET_PLAN_QUERY]) {
    assert.match(queryText, /workspace_id = \$1/);
    assert.match(queryText, /budget_month = to_date\(\$2, 'YYYY-MM'\)/);
    assert.match(queryText, /AND direction = \$3/);
    assert.match(queryText, /AND category = \$4/);
    assert.match(queryText, /AND kind = \$5/);
  }
  assert.match(UPDATE_BUDGET_PLAN_QUERY, /SET planned_value = \$6, currency = \$7/);
});
