import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BUDGET_PLAN_VS_ACTUAL_QUERY_EXAMPLE } from "@expense-budget-tracker/agent-shared/agent-protocol";
import {
  executeValidatedExpenseSql,
  validateSingleReadOnlyExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import pg from "pg";
import { z } from "zod";

import { QUERY } from "@/server/budget/getBudgetGrid";
import { runWithContext, runWithReadOnlyContext, type QueryFn } from "@/server/db/contextRunner";

type BudgetDirection = "income" | "spend";

type BaseLineSeed = Readonly<{
  direction: BudgetDirection;
  category: string;
  plannedValue: string;
}>;

type AdjustmentSeed = Readonly<{
  budgetMonth: string;
  direction: BudgetDirection;
  category: string;
  amount: string;
}>;

type LedgerEntrySeed = Readonly<{
  ts: string;
  accountId: string;
  amount: string;
  currency: string;
  kind: BudgetDirection;
  category: string;
}>;

type FxRateSeed = Readonly<{
  baseCurrency: string;
  quoteCurrency: string;
  calendarDate: string;
  rate: string;
}>;

type RecipeFixture = Readonly<{
  userId: string;
  workspaceId: string;
  adjustmentIdPrefix: string;
}>;

type PlanVsActualCell = Readonly<{
  direction: string;
  category: string;
  planned: number;
  actual: number;
  remaining: number;
  hasUnconvertedEntries: boolean;
}>;

type SessionRole = "app" | "api_sql_reader";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed plan-vs-actual recipe comparison test";
// CI has to prove the recipe matches the grid, so missing database wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const FIXTURE_MONTH = "2026-03";
const MONTH_START = "2026-03-01";
const NEXT_MONTH_START = "2026-04-01";
const REPORTING_CURRENCY = "USD";

const EUR_USD_RATE: FxRateSeed = {
  baseCurrency: "EUR",
  quoteCurrency: REPORTING_CURRENCY,
  calendarDate: "2026-03-10",
  rate: "1.5",
};

// One row per cell, which budget_lines_cell_idx now enforces.
const BASE_LINES: ReadonlyArray<BaseLineSeed> = [
  { direction: "income", category: "Salary", plannedValue: "1000" },
  { direction: "spend", category: "Groceries", plannedValue: "400" },
];

const ADJUSTMENTS: ReadonlyArray<AdjustmentSeed> = [
  { budgetMonth: MONTH_START, direction: "income", category: "Salary", amount: "200" },
  { budgetMonth: MONTH_START, direction: "income", category: "Salary", amount: "-50" },
  // Travel has no Base row, so only the adjustment side of the plan join can surface it.
  { budgetMonth: MONTH_START, direction: "spend", category: "Travel", amount: "120" },
  // Belongs to the next month and must not reach the fixture month's plan.
  { budgetMonth: NEXT_MONTH_START, direction: "income", category: "Salary", amount: "999" },
];

// Noon UTC keeps every entry inside its calendar day whatever the session time zone.
const LEDGER_ENTRIES: ReadonlyArray<LedgerEntrySeed> = [
  { ts: "2026-03-10T12:00:00.000Z", accountId: "checking-usd", amount: "700", currency: "USD", kind: "income", category: "Salary" },
  { ts: "2026-03-10T12:00:00.000Z", accountId: "checking-eur", amount: "200", currency: "EUR", kind: "income", category: "Salary" },
  { ts: "2026-03-12T12:00:00.000Z", accountId: "checking-usd", amount: "-250", currency: "USD", kind: "spend", category: "Groceries" },
  // A refund is a positive spend amount.
  { ts: "2026-03-14T12:00:00.000Z", accountId: "checking-usd", amount: "30", currency: "USD", kind: "spend", category: "Groceries" },
];

// Salary: planned 1000 + 200 - 50, actual 700 + 200 EUR * 1.5. Groceries: actual 250 - 30.
const EXPECTED_CELLS: ReadonlyArray<PlanVsActualCell> = [
  { direction: "income", category: "Salary", planned: 1150, actual: 1000, remaining: 150, hasUnconvertedEntries: false },
  { direction: "spend", category: "Groceries", planned: 400, actual: 220, remaining: 180, hasUnconvertedEntries: false },
  { direction: "spend", category: "Travel", planned: 120, actual: 0, remaining: 120, hasUnconvertedEntries: false },
];

const RECIPE_PLACEHOLDER_VALUES: ReadonlyArray<readonly [placeholder: string, value: string]> = [
  ["<month-start YYYY-MM-DD>", MONTH_START],
  ["<next-month-start YYYY-MM-DD>", NEXT_MONTH_START],
  ["<reporting-currency>", REPORTING_CURRENCY],
];

const GRID_ROW_SCHEMA = z.object({
  month: z.literal(FIXTURE_MONTH),
  direction: z.string(),
  category: z.string(),
  planned: z.number(),
  actual: z.number(),
  has_unconvertible: z.boolean(),
});

// pg returns NUMERIC and BIGINT values as exact decimal text.
const DECIMAL_TEXT_SCHEMA = z.string().regex(/^-?\d+(?:\.\d+)?$/u).transform((value): number => Number(value));

const RECIPE_ROW_SCHEMA = z.object({
  direction: z.string(),
  category: z.string(),
  planned: DECIMAL_TEXT_SCHEMA,
  actual: DECIMAL_TEXT_SCHEMA,
  remaining: DECIMAL_TEXT_SCHEMA,
  unconverted_entries: DECIMAL_TEXT_SCHEMA,
});

const createFixture = (): RecipeFixture => {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    userId: `plan-vs-actual-user-${suffix}`,
    workspaceId: `plan-vs-actual-workspace-${suffix}`,
    adjustmentIdPrefix: `plan-vs-actual-adjustment-${suffix}`,
  };
};

const substituteRecipePlaceholders = (template: string): string =>
  RECIPE_PLACEHOLDER_VALUES.reduce((sql: string, [placeholder, value]): string => {
    assert.ok(sql.includes(placeholder), `The recipe no longer contains the placeholder ${placeholder}`);
    return sql.replaceAll(placeholder, value);
  }, template);

const runOwnerTransaction = async (
  pool: pg.Pool,
  callback: (client: pg.PoolClient) => Promise<void>,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await callback(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const insertFixture = async (pool: pg.Pool, fixture: RecipeFixture): Promise<void> =>
  runOwnerTransaction(pool, async (client): Promise<void> => {
    await client.query(
      `INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled)
       VALUES ($1, $2, true, 'CONFIRMED', true)`,
      [fixture.userId, `${fixture.userId}@example.invalid`],
    );
    await client.query(
      "INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, $2)",
      [fixture.workspaceId, "plan-vs-actual recipe test"],
    );
    await client.query(
      "INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [fixture.workspaceId, fixture.userId],
    );
    await client.query(
      "INSERT INTO public.workspace_settings (workspace_id, reporting_currency) VALUES ($1, $2)",
      [fixture.workspaceId, REPORTING_CURRENCY],
    );
    for (const line of BASE_LINES) {
      await client.query(
        `INSERT INTO public.budget_lines
           (workspace_id, budget_month, direction, category, currency, planned_value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          fixture.workspaceId,
          MONTH_START,
          line.direction,
          line.category,
          REPORTING_CURRENCY,
          line.plannedValue,
        ],
      );
    }
    for (const [index, adjustment] of ADJUSTMENTS.entries()) {
      await client.query(
        `INSERT INTO public.budget_adjustments
           (adjustment_id, workspace_id, budget_month, direction, category, amount, origin)
         VALUES ($1, $2, $3, $4, $5, $6, 'user')`,
        [
          `${fixture.adjustmentIdPrefix}-${String(index + 1)}`,
          fixture.workspaceId,
          adjustment.budgetMonth,
          adjustment.direction,
          adjustment.category,
          adjustment.amount,
        ],
      );
    }
    for (const entry of LEDGER_ENTRIES) {
      await client.query(
        `INSERT INTO public.ledger_entries
           (event_id, ts, account_id, amount, currency, kind, category, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          entry.ts,
          entry.accountId,
          entry.amount,
          entry.currency,
          entry.kind,
          entry.category,
          fixture.workspaceId,
        ],
      );
    }
    await client.query(
      `INSERT INTO public.fx_rates_daily (base_currency, quote_currency, calendar_date, rate, source_rate_date)
       VALUES ($1, $2, $3, $4, $3)`,
      [EUR_USD_RATE.baseCurrency, EUR_USD_RATE.quoteCurrency, EUR_USD_RATE.calendarDate, EUR_USD_RATE.rate],
    );
  });

const deleteFixture = async (pool: pg.Pool, fixture: RecipeFixture): Promise<void> =>
  runOwnerTransaction(pool, async (client): Promise<void> => {
    await client.query("DELETE FROM public.budget_adjustments WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.budget_lines WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.ledger_entries WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.workspace_settings WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.workspace_members WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.workspaces WHERE workspace_id = $1", [fixture.workspaceId]);
    await client.query("DELETE FROM public.users WHERE user_id = $1", [fixture.userId]);
    await client.query(
      "DELETE FROM public.fx_rates_daily WHERE base_currency = $1 AND quote_currency = $2 AND calendar_date = $3",
      [EUR_USD_RATE.baseCurrency, EUR_USD_RATE.quoteCurrency, EUR_USD_RATE.calendarDate],
    );
  });

const assertSessionRole = async (queryFn: QueryFn, effectiveRole: SessionRole): Promise<void> => {
  const session = await queryFn("SELECT session_user AS session_role, current_user AS effective_role", []);
  assert.deepEqual(session.rows, [{ session_role: "app", effective_role: effectiveRole }]);
};

/**
 * Runs QUERY the way getBudgetGrid does: as app under the workspace context,
 * with plan and actual ranges that both cover the fixture month.
 */
const readGridCells = async (pool: pg.Pool, fixture: RecipeFixture): Promise<ReadonlyArray<PlanVsActualCell>> => {
  const result = await runWithContext(
    pool,
    { userId: fixture.userId, workspaceId: fixture.workspaceId, statementTimeoutMs: null, restrictedRole: null },
    async (queryFn) => {
      await assertSessionRole(queryFn, "app");
      // getBudgetGrid's parameter order: reportCurrency, monthFrom, monthTo, planFrom, actualTo.
      return queryFn(QUERY, [REPORTING_CURRENCY, FIXTURE_MONTH, FIXTURE_MONTH, FIXTURE_MONTH, FIXTURE_MONTH]);
    },
  );
  return z.array(GRID_ROW_SCHEMA).parse(result.rows).map((row): PlanVsActualCell => ({
    direction: row.direction,
    category: row.category,
    planned: row.planned,
    actual: row.actual,
    remaining: row.planned - row.actual,
    hasUnconvertedEntries: row.has_unconvertible,
  }));
};

/**
 * Runs the recipe the way the agent read path does: validated by the restricted
 * SQL policy, then executed as api_sql_reader in a read-only transaction.
 */
const readRecipeCells = async (pool: pg.Pool, fixture: RecipeFixture): Promise<ReadonlyArray<PlanVsActualCell>> => {
  const validated = validateSingleReadOnlyExpenseSql(substituteRecipePlaceholders(BUDGET_PLAN_VS_ACTUAL_QUERY_EXAMPLE));
  const executed = await runWithReadOnlyContext(
    pool,
    {
      userId: fixture.userId,
      workspaceId: fixture.workspaceId,
      statementTimeoutMs: null,
      restrictedRole: "api_sql_reader",
    },
    async (queryFn) => {
      await assertSessionRole(queryFn, "api_sql_reader");
      return executeValidatedExpenseSql(validated, (request) => queryFn(request.sql, request.params));
    },
  );
  assert.equal(executed.statements.length, 1);
  const statement = executed.statements[0];
  assert.ok(statement !== undefined);
  assert.equal(statement.truncated, false);
  return z.array(RECIPE_ROW_SCHEMA).parse(statement.rows).map((row): PlanVsActualCell => ({
    direction: row.direction,
    category: row.category,
    planned: row.planned,
    actual: row.actual,
    remaining: row.remaining,
    hasUnconvertedEntries: row.unconverted_entries > 0,
  }));
};

test(
  "the plan-vs-actual query recipe returns the budget grid's planned, actual, and remaining figures",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const fixture = createFixture();
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const appPool = new pg.Pool({ connectionString: appDatabaseUrl });
    // Seeding is one transaction, so a failed seed left nothing behind, and
    // cleaning up after it could delete an fx_rates_daily row this test never owned.
    let fixtureSeeded = false;

    try {
      await insertFixture(ownerPool, fixture);
      fixtureSeeded = true;

      const gridCells = await readGridCells(appPool, fixture);
      const recipeCells = await readRecipeCells(appPool, fixture);
      assert.deepEqual(gridCells, EXPECTED_CELLS, "the grid must show the fixture's plan and actuals");
      assert.deepEqual(recipeCells, gridCells, "the recipe must return the grid's figures");
    } finally {
      try {
        if (fixtureSeeded) {
          await deleteFixture(ownerPool, fixture);
        }
      } finally {
        await Promise.all([ownerPool.end(), appPool.end()]);
      }
    }
  },
);
