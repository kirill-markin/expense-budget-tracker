import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";

import { getCurrentMonth, offsetMonth } from "@/lib/monthUtils";
import { BUDGET_ADJUSTMENT_BY_ID_QUERY, BUDGET_ADJUSTMENTS_DETAIL_QUERY, BudgetAdjustmentConflictError, CREATE_BUDGET_ADJUSTMENT_QUERY, buildPatchBudgetAdjustmentQuery, createBudgetAdjustmentWithQuery, mapBudgetAdjustmentRow, type BudgetAdjustment, type CreateBudgetAdjustmentParams } from "@/server/budget/budgetAdjustments";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  createDemoBudgetAdjustment,
  deleteDemoBudgetAdjustment,
  EMPTY_DEMO_BUDGET_ADJUSTMENT_SESSION,
  getDemoBudgetAdjustmentsForSession,
  parseDemoBudgetAdjustmentSessionCookie,
  patchDemoBudgetAdjustment,
  serializeDemoBudgetAdjustmentSessionCookie,
  type DemoBudgetAdjustmentSessionState,
} from "@/server/demo/budgetAdjustments";
import { getDemoBudgetAdjustments, getDemoBudgetGrid } from "@/server/demo/data";

const CREATE_PARAMS: CreateBudgetAdjustmentParams = {
  adjustmentId: "b8e8703c-f57a-456d-a56d-3d05ae8cffcd",
  month: "2026-08",
  direction: "spend",
  category: "Groceries",
  amount: -20,
  note: null,
};

const CREATE_DB_ROW = {
  adjustment_id: CREATE_PARAMS.adjustmentId,
  month: CREATE_PARAMS.month,
  direction: CREATE_PARAMS.direction,
  category: CREATE_PARAMS.category,
  amount: CREATE_PARAMS.amount,
  note: CREATE_PARAMS.note,
  created_at: new Date("2026-07-20T10:00:00.000Z"),
  updated_at: new Date("2026-07-20T10:00:00.000Z"),
} as const;

const createDemoGridAdjustment = (
  adjustmentId: string,
  month: string,
  direction: "income" | "spend",
  category: string,
  amount: number,
): BudgetAdjustment => ({
  adjustmentId,
  month,
  direction,
  category,
  amount,
  note: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const createQuerySequence = (
  rowSets: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
): Readonly<{ queryFn: QueryFn; calls: Array<QueryCall> }> => {
  const calls: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    const rows = rowSets[calls.length];
    if (rows === undefined) {
      throw new Error(`Unexpected budget adjustment test query ${calls.length + 1}`);
    }
    calls.push({ text, params });
    return { rows: [...rows], rowCount: rows.length, command: "", oid: 0, fields: [] };
  };
  return { queryFn, calls };
};

test("mapBudgetAdjustmentRow returns the browser contract without workspace or origin", (): void => {
  const createdAt = new Date("2026-07-20T10:00:00.000Z");
  const updatedAt = new Date("2026-07-21T11:00:00.000Z");
  const adjustment = mapBudgetAdjustmentRow({
    adjustment_id: "adjustment-1",
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
    amount: -20,
    note: null,
    created_at: createdAt,
    updated_at: updatedAt,
  }, "test");

  assert.deepEqual(adjustment, {
    adjustmentId: "adjustment-1",
    month: "2026-08",
    direction: "spend",
    category: "Groceries",
    amount: -20,
    note: null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
  assert.equal("workspaceId" in adjustment, false);
  assert.equal("origin" in adjustment, false);
});

test("mapBudgetAdjustmentRow accepts JavaScript safe-integer boundaries", (): void => {
  for (const amount of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    assert.equal(mapBudgetAdjustmentRow({
      adjustment_id: `adjustment-${amount}`,
      month: "2026-08",
      direction: "income",
      category: "Boundary",
      amount,
      note: null,
      created_at: new Date("2026-07-20T10:00:00.000Z"),
      updated_at: new Date("2026-07-20T10:00:00.000Z"),
    }, "boundary test").amount, amount);
  }
});

test("mapBudgetAdjustmentRow counts category and note limits in Unicode code points", (): void => {
  const category = "\u{1F600}".repeat(200);
  const note = "\u{1F680}".repeat(2000);
  const validRow = {
    adjustment_id: "adjustment-unicode-boundary",
    month: "2026-08",
    direction: "income",
    category,
    amount: 0,
    note,
    created_at: new Date("2026-07-20T10:00:00.000Z"),
    updated_at: new Date("2026-07-20T10:00:00.000Z"),
  } as const;

  const adjustment = mapBudgetAdjustmentRow(validRow, "Unicode boundary test");
  assert.equal(adjustment.category, category);
  assert.equal(adjustment.note, note);
  assert.throws(
    () => mapBudgetAdjustmentRow({
      ...validRow,
      category: "\u{1F600}".repeat(201),
    }, "Unicode category overflow test"),
    /Invalid budget adjustment database row.*category/,
  );
  assert.throws(
    () => mapBudgetAdjustmentRow({
      ...validRow,
      note: "\u{1F680}".repeat(2001),
    }, "Unicode note overflow test"),
    /Invalid budget adjustment database row.*note/,
  );
});

test("mapBudgetAdjustmentRow rejects invalid database values", (): void => {
  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-1",
      month: "2026-08",
      direction: "spend",
      category: "Groceries",
      amount: 1.5,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*amount/,
  );

  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-empty-category",
      month: "2026-08",
      direction: "spend",
      category: "",
      amount: 1,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*category/,
  );
  assert.throws(
    () => mapBudgetAdjustmentRow({
      adjustment_id: "adjustment-unsafe-amount",
      month: "2026-08",
      direction: "spend",
      category: "Groceries",
      amount: Number.MAX_SAFE_INTEGER + 1,
      note: null,
      created_at: new Date(),
      updated_at: new Date(),
    }, "test"),
    /Invalid budget adjustment database row.*amount/,
  );
});

test("create inserts the client ID and returns a newly inserted row", async (): Promise<void> => {
  const sequence = createQuerySequence([[CREATE_DB_ROW]]);
  const adjustment = await createBudgetAdjustmentWithQuery(
    sequence.queryFn,
    "workspace-1",
    CREATE_PARAMS,
  );

  assert.equal(adjustment.adjustmentId, CREATE_PARAMS.adjustmentId);
  assert.equal(sequence.calls.length, 1);
  assert.equal(sequence.calls[0]?.text, CREATE_BUDGET_ADJUSTMENT_QUERY);
  assert.deepEqual(sequence.calls[0]?.params, [
    "workspace-1",
    CREATE_PARAMS.adjustmentId,
    CREATE_PARAMS.month,
    CREATE_PARAMS.direction,
    CREATE_PARAMS.category,
    CREATE_PARAMS.amount,
    CREATE_PARAMS.note,
  ]);
  assert.match(CREATE_BUDGET_ADJUSTMENT_QUERY, /ON CONFLICT \(adjustment_id\) DO NOTHING/);
  assert.doesNotMatch(CREATE_BUDGET_ADJUSTMENT_QUERY, /DO UPDATE/);
});

test("an exact create retry returns the existing row without changing timestamps", async (): Promise<void> => {
  const sequence = createQuerySequence([[], [CREATE_DB_ROW]]);
  const adjustment = await createBudgetAdjustmentWithQuery(
    sequence.queryFn,
    "workspace-1",
    CREATE_PARAMS,
  );

  assert.equal(adjustment.createdAt, CREATE_DB_ROW.created_at.toISOString());
  assert.equal(adjustment.updatedAt, CREATE_DB_ROW.updated_at.toISOString());
  assert.equal(sequence.calls[1]?.text, BUDGET_ADJUSTMENT_BY_ID_QUERY);
  assert.deepEqual(sequence.calls[1]?.params, ["workspace-1", CREATE_PARAMS.adjustmentId]);
});

test("create conflicts are explicit and do not distinguish hidden from changed rows", async (): Promise<void> => {
  for (const existingRows of [
    [{ ...CREATE_DB_ROW, month: "2026-09" }],
    [{ ...CREATE_DB_ROW, direction: "income" }],
    [{ ...CREATE_DB_ROW, category: "Dining" }],
    [{ ...CREATE_DB_ROW, amount: 1 }],
    [{ ...CREATE_DB_ROW, note: "different" }],
    [],
  ]) {
    const sequence = createQuerySequence([[], existingRows]);
    await assert.rejects(
      createBudgetAdjustmentWithQuery(sequence.queryFn, "workspace-1", CREATE_PARAMS),
      (error: unknown): boolean => {
        assert.ok(error instanceof BudgetAdjustmentConflictError);
        assert.equal(
          error.message,
          `Budget adjustment ID "${CREATE_PARAMS.adjustmentId}" is already in use`,
        );
        assert.doesNotMatch(error.message, /workspace|Groceries|different/);
        return true;
      },
    );
  }
});

test("patch query changes only supplied editable columns and scopes by workspace and id", (): void => {
  const query = buildPatchBudgetAdjustmentQuery("workspace-1", "adjustment-1", {
    amount: 0,
    note: null,
    month: "2026-09",
    category: "Dining",
  });

  assert.deepEqual(query.params, ["workspace-1", "adjustment-1", 0, null, "2026-09", "Dining"]);
  assert.match(query.text, /amount = \$3/);
  assert.match(query.text, /note = \$4/);
  assert.match(query.text, /budget_month = to_date\(\$5, 'YYYY-MM'\)/);
  assert.match(query.text, /category = \$6/);
  assert.match(query.text, /WHERE workspace_id = \$1\s+AND adjustment_id = \$2/);
  assert.doesNotMatch(query.text, /SET[^]*direction\s*=/);
  assert.doesNotMatch(query.text, /origin\s*=/);
});

test("detail query is one deterministic workspace and month-range scan", (): void => {
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /WHERE workspace_id = \$1/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /budget_month >= to_date\(\$2, 'YYYY-MM'\)/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /budget_month < \(to_date\(\$3, 'YYYY-MM'\) \+ interval '1 month'\)::date/);
  assert.match(BUDGET_ADJUSTMENTS_DETAIL_QUERY, /ORDER BY budget_month, direction, category, created_at, adjustment_id/);
});

test("demo adjustment session state is validated and bounded without eviction", (): void => {
  assert.throws(
    () => parseDemoBudgetAdjustmentSessionCookie("invalid-cookie"),
    /Invalid demo budget adjustment session cookie/,
  );
  let state: DemoBudgetAdjustmentSessionState = EMPTY_DEMO_BUDGET_ADJUSTMENT_SESSION;
  for (let index = 1; index <= 9; index += 1) {
    state = createDemoBudgetAdjustment(state, {
      adjustmentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      month: getCurrentMonth(),
      direction: "income",
      category: `Demo ${index}`,
      amount: index,
      note: null,
    }).state;
  }
  assert.throws(
    () => serializeDemoBudgetAdjustmentSessionCookie(state),
    /supports at most 8 changed rows/,
  );
});

test("demo adjustment session serialization preserves zero rows, null notes, moves, and seeded deletions", (): void => {
  const adjustmentId = "00000000-0000-4000-8000-000000000010";
  const destinationMonth = offsetMonth(getCurrentMonth(), 3);
  const seededAdjustment = getDemoBudgetAdjustments()[0];
  assert.ok(seededAdjustment);
  let state = createDemoBudgetAdjustment(
    EMPTY_DEMO_BUDGET_ADJUSTMENT_SESSION,
    {
      adjustmentId,
      month: getCurrentMonth(),
      direction: "spend",
      category: "Groceries",
      amount: 0,
      note: null,
    },
  ).state;
  state = patchDemoBudgetAdjustment(
    state,
    adjustmentId,
    {
      month: destinationMonth,
      category: "Travel reserve",
      amount: 0,
      note: null,
    },
    "2026-07-24T12:00:00.000Z",
  ).state;
  state = deleteDemoBudgetAdjustment(
    state,
    seededAdjustment.adjustmentId,
  );

  const cookie = serializeDemoBudgetAdjustmentSessionCookie(state);
  const cookieValue = cookie.split(";", 1)[0]?.split("=", 2)[1];
  assert.ok(cookieValue);
  const restored = getDemoBudgetAdjustmentsForSession(
    parseDemoBudgetAdjustmentSessionCookie(cookieValue),
  );

  assert.equal(
    restored.some((adjustment) =>
      adjustment.adjustmentId === seededAdjustment.adjustmentId),
    false,
  );
  assert.deepEqual(
    restored.find((adjustment) => adjustment.adjustmentId === adjustmentId),
    {
      adjustmentId,
      month: destinationMonth,
      direction: "spend",
      category: "Travel reserve",
      amount: 0,
      note: null,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
    },
  );
});

test("demo adjustment details exactly match cell modifiers and include adjustment-only cells", (): void => {
  const currentMonth = getCurrentMonth();
  const nextMonth = offsetMonth(currentMonth, 1);
  const grid = getDemoBudgetGrid(
    currentMonth,
    nextMonth,
    currentMonth,
    currentMonth,
    getDemoBudgetAdjustments(),
  );
  const sums = new Map<string, number>();

  for (const adjustment of grid.adjustments) {
    const key = `${adjustment.month}|${adjustment.direction}|${adjustment.category}`;
    sums.set(key, (sums.get(key) ?? 0) + adjustment.amount);
  }

  for (const [key, sum] of sums) {
    const [month, direction, category] = key.split("|");
    const row = grid.rows.find((candidate) =>
      candidate.month === month
      && candidate.direction === direction
      && candidate.category === category);
    assert.ok(row, `Missing demo budget row for ${key}`);
    assert.equal(row.plannedModifier, sum);
    assert.equal(row.planned, row.plannedBase + sum);
  }

  const adjustmentOnly = grid.rows.find((row) =>
    row.month === nextMonth && row.direction === "spend" && row.category === "Travel reserve");
  assert.ok(adjustmentOnly);
  assert.equal(adjustmentOnly.plannedBase, 0);
  assert.equal(adjustmentOnly.plannedModifier, 300);
  assert.equal(adjustmentOnly.planned, 300);
});

test("demo adjustment aggregation preserves categories containing separators", (): void => {
  const month = getCurrentMonth();
  const category = "Travel|Weekend";
  const grid = getDemoBudgetGrid(
    month,
    month,
    month,
    month,
    [createDemoGridAdjustment("separator", month, "spend", category, 25)],
  );

  const row = grid.rows.find((candidate) =>
    candidate.month === month
    && candidate.direction === "spend"
    && candidate.category === category);
  assert.ok(row);
  assert.equal(row.plannedModifier, 25);
  assert.equal(row.planned, 25);
});

test("demo adjustment aggregation is exact at safe boundaries and rejects overflow", (): void => {
  const month = getCurrentMonth();
  const maximum = Number.MAX_SAFE_INTEGER;
  const exactGrid = getDemoBudgetGrid(
    month,
    month,
    month,
    month,
    [
      createDemoGridAdjustment("maximum", month, "spend", "Exact", maximum),
      createDemoGridAdjustment("two", month, "spend", "Exact", 2),
      createDemoGridAdjustment("cancel", month, "spend", "Exact", -maximum),
      createDemoGridAdjustment("boundary", month, "spend", "Boundary", maximum),
    ],
  );
  assert.equal(
    exactGrid.rows.find((row) => row.category === "Exact")?.plannedModifier,
    2,
  );
  assert.equal(
    exactGrid.rows.find((row) => row.category === "Boundary")?.plannedModifier,
    maximum,
  );

  assert.throws(
    () => getDemoBudgetGrid(
      month,
      month,
      month,
      month,
      [
        createDemoGridAdjustment("maximum", month, "spend", "Overflow", maximum),
        createDemoGridAdjustment("one", month, "spend", "Overflow", 1),
      ],
    ),
    /modifier is outside the JavaScript safe integer range/,
  );
  assert.throws(
    () => getDemoBudgetGrid(
      month,
      month,
      month,
      month,
      [createDemoGridAdjustment("planned", month, "income", "Salary", maximum)],
    ),
    /planned value is outside the JavaScript safe integer range/,
  );
});
