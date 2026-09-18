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
  plannedValue: 1200,
};

const CELL_PARAMS: ReadonlyArray<unknown> = [
  "workspace-1",
  PARAMS.month,
  PARAMS.direction,
  PARAMS.category,
];

const WRITE_PARAMS: ReadonlyArray<unknown> = [...CELL_PARAMS, PARAMS.plannedValue, "EUR"];

const UPDATED_ROWS: ReadonlyArray<unknown> = [{ line_id: "line-1" }];

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type QueryOutcome =
  | Readonly<{ rows: ReadonlyArray<unknown> }>
  | Readonly<{ error: Error }>;

const uniqueViolation = (): Error =>
  Object.assign(
    new Error('duplicate key value violates unique constraint "budget_lines_cell_idx"'),
    { code: "23505", constraint: "budget_lines_cell_idx" },
  );

const primaryKeyViolation = (): Error =>
  Object.assign(
    new Error('duplicate key value violates unique constraint "budget_lines_pkey"'),
    { code: "23505", constraint: "budget_lines_pkey" },
  );

const createQuerySequence = (
  outcomes: ReadonlyArray<QueryOutcome>,
): Readonly<{ queryFn: QueryFn; calls: Array<QueryCall> }> => {
  const calls: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    const outcome = outcomes[calls.length];
    if (outcome === undefined) {
      throw new Error(`Unexpected budget plan test query ${calls.length + 1}: ${text}`);
    }
    calls.push({ text, params });
    if ("error" in outcome) {
      throw outcome.error;
    }
    return {
      rows: [...outcome.rows],
      rowCount: outcome.rows.length,
      command: "",
      oid: 0,
      fields: [],
    };
  };
  return { queryFn, calls };
};

test("saving a value updates the existing cell and inserts nothing", async (): Promise<void> => {
  const sequence = createQuerySequence([{ rows: UPDATED_ROWS }]);

  await saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS);

  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, UPDATE_BUDGET_PLAN_QUERY);
  assert.deepEqual(sequence.calls[0]?.params, WRITE_PARAMS);
});

test("saving a value inserts the first cell when the update affects no row", async (): Promise<void> => {
  const sequence = createQuerySequence([
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);

  await saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS);

  assert.deepEqual(
    sequence.calls.map((call): string => call.text),
    [
      UPDATE_BUDGET_PLAN_QUERY,
      "SAVEPOINT budget_plan_insert",
      INSERT_BUDGET_PLAN_QUERY,
      "RELEASE SAVEPOINT budget_plan_insert",
    ],
  );
  assert.deepEqual(sequence.calls[2]?.params, WRITE_PARAMS);
});

test("a concurrent first save of the same cell retries the update once", async (): Promise<void> => {
  const sequence = createQuerySequence([
    { rows: [] },
    { rows: [] },
    { error: uniqueViolation() },
    { rows: [] },
    { rows: UPDATED_ROWS },
  ]);

  await saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS);

  assert.deepEqual(
    sequence.calls.map((call): string => call.text),
    [
      UPDATE_BUDGET_PLAN_QUERY,
      "SAVEPOINT budget_plan_insert",
      INSERT_BUDGET_PLAN_QUERY,
      "ROLLBACK TO SAVEPOINT budget_plan_insert",
      UPDATE_BUDGET_PLAN_QUERY,
    ],
  );
  assert.deepEqual(sequence.calls[4]?.params, WRITE_PARAMS);
});

test("a unique violation with no row left to update is an explicit error", async (): Promise<void> => {
  const sequence = createQuerySequence([
    { rows: [] },
    { rows: [] },
    { error: uniqueViolation() },
    { rows: [] },
    { rows: [] },
  ]);

  await assert.rejects(
    saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS),
    /2026-08 spend Groceries hit a unique violation, but the cell then had no row to update/,
  );
  assert.equal(sequence.calls.length, 5);
});

test("a unique violation of another constraint keeps its own error", async (): Promise<void> => {
  const sequence = createQuerySequence([
    { rows: [] },
    { rows: [] },
    { error: primaryKeyViolation() },
  ]);

  await assert.rejects(
    saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS),
    /budget_lines_pkey/,
  );
  assert.equal(sequence.calls.length, 3);
});

test("an insert failure that is not a unique violation is not retried", async (): Promise<void> => {
  const sequence = createQuerySequence([
    { rows: [] },
    { rows: [] },
    { error: new Error("budget plan insert failed") },
  ]);

  await assert.rejects(
    saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", "EUR", PARAMS),
    /budget plan insert failed/,
  );
  assert.equal(sequence.calls.length, 3);
});

test("saving zero deletes the cell without a reporting currency", async (): Promise<void> => {
  const sequence = createQuerySequence([{ rows: [] }]);

  await saveBudgetPlanWithQuery(
    sequence.queryFn,
    "workspace-1",
    null,
    { ...PARAMS, plannedValue: 0 },
  );

  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, DELETE_BUDGET_PLAN_QUERY);
  assert.deepEqual(sequence.calls[0]?.params, CELL_PARAMS);
});

test("storing a value without a reporting currency is an explicit error", async (): Promise<void> => {
  const sequence = createQuerySequence([]);

  await assert.rejects(
    saveBudgetPlanWithQuery(sequence.queryFn, "workspace-1", null, PARAMS),
    /2026-08 spend Groceries needs the workspace reporting currency/,
  );
  assert.equal(sequence.calls.length, 0);
});

test("every plan write scopes one cell and avoids ON CONFLICT", (): void => {
  for (const queryText of [
    DELETE_BUDGET_PLAN_QUERY,
    UPDATE_BUDGET_PLAN_QUERY,
    INSERT_BUDGET_PLAN_QUERY,
  ]) {
    assert.doesNotMatch(queryText, /ON CONFLICT/);
    assert.doesNotMatch(queryText, /kind/);
  }
  for (const queryText of [DELETE_BUDGET_PLAN_QUERY, UPDATE_BUDGET_PLAN_QUERY]) {
    assert.match(queryText, /workspace_id = \$1/);
    assert.match(queryText, /budget_month = to_date\(\$2, 'YYYY-MM'\)/);
    assert.match(queryText, /AND direction = \$3/);
    assert.match(queryText, /AND category = \$4/);
  }
  assert.match(UPDATE_BUDGET_PLAN_QUERY, /SET planned_value = \$5, currency = \$6/);
  assert.match(UPDATE_BUDGET_PLAN_QUERY, /RETURNING line_id/);
});
