/**
 * Budget grid assembly for the budget dashboard.
 *
 * Runs six queries in true parallel (separate DB connections via queryAs):
 * 1. QUERY — planned (base + modifier) vs actual per month/direction/category,
 *    with FX conversion via exact-date joins on fx_rates_daily. Plan uses
 *    last-write-wins on inserted_at.
 * 2. CUMULATIVE_BALANCE — actual income/spend/transfer totals before the loaded
 *    range, used as the Balance row starting point.
 * 3. WARNINGS — currencies missing exchange rates.
 * 4. MONTH_END_BALANCES — mark-to-market portfolio balance at each month-end,
 *    used to anchor the Balance row and derive FX adjustments.
 * 5. BUSINESS_PERSONAL_TRANSFER — net transfer amount on the personal side of
 *    events crossing explicitly business and personal accounts.
 * 6. HAS_BUSINESS_ACCOUNT — whether the workspace has any explicit business
 *    account classification, used to show or hide the derived row.
 *
 * Performance notes:
 * - The worker already expanded raw market data into exact-date all-pairs rows.
 *   Read queries use fx_rates_daily directly and never re-derive carry-forward.
 * - MONTH_END_BALANCES uses le.currency directly instead of joining the
 *   accounts view (which triggers a redundant full scan of ledger_entries
 *   via MODE() WITHIN GROUP).
 * - Each query runs on its own pooled connection (queryAs) so Promise.all
 *   achieves true DB-level parallelism. The old withUserContext shared one
 *   connection, serializing all queries despite Promise.all.
 */
import { queryAs } from "@/server/db";
import { getLatestFxCalendarDate } from "@/server/fxRates";
import { getReportCurrency } from "@/server/reportCurrency";

export type BudgetRow = Readonly<{
  month: string;
  direction: string;
  category: string;
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  actual: number;
  hasUnconvertible: boolean;
}>;

export type ConversionWarning = Readonly<{
  currency: string;
  reason: string;
}>;

/**
 * Cumulative actual totals for all months before the loaded range, grouped by direction.
 * Used as the starting point for the Balance row. Only actual values are needed
 * because all months before the loaded range are closed (past).
 * Includes all directions (income, spend, transfer) with no category filter,
 * so the balance matches the full ledger.
 */
export type CumulativeBefore = Readonly<{
  incomeActual: number;
  spendActual: number;
  transferActual: number;
}>;

export type BusinessPersonalTransferCell = Readonly<{
  actual: number;
  hasUnconvertible: boolean;
}>;

export type BudgetGridResult = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  /**
   * Actual portfolio balance in report currency at the end of each month, keyed by "YYYY-MM".
   * Computed as: running native-currency balance per currency, converted at the
   * exchange rate at month-end, capped to the latest available FX build day for
   * open months. Covers months from one month before monthFrom up to actualTo.
   * Used by the UI to anchor the
   * Balance row to reality and derive the per-month FX adjustment.
   */
  monthEndBalances: Readonly<Record<string, number>>;
  /**
   * Month-end balances broken down by liquidity tier ("high" | "medium" | "low").
   * Keyed by "YYYY-MM" → liquidity → balance in report currency.
   */
  monthEndBalancesByLiquidity: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /**
   * Net transfers between business and personal accounts, keyed by "YYYY-MM".
   * The value is the report-currency amount on the personal side: positive for
   * business -> personal and negative for personal -> business.
   */
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
}>;

export const QUERY = `
  WITH latest_plans AS (
    SELECT
      budget_month, direction, category, kind, planned_value,
      ROW_NUMBER() OVER (
        PARTITION BY budget_month, direction, category, kind
        ORDER BY inserted_at DESC
      ) AS rn
    FROM budget_lines
    WHERE budget_month >= GREATEST(to_date($4, 'YYYY-MM'), to_date($2, 'YYYY-MM'))
      AND budget_month < to_date($3, 'YYYY-MM') + interval '1 month'
  ),
  planned AS (
    SELECT
      to_char(budget_month, 'YYYY-MM') AS month,
      direction,
      category,
      COALESCE(MAX(CASE WHEN kind = 'base' THEN planned_value::double precision END), 0) AS planned_base,
      COALESCE(MAX(CASE WHEN kind = 'modifier' THEN planned_value::double precision END), 0) AS planned_modifier
    FROM latest_plans
    WHERE rn = 1
    GROUP BY 1, 2, 3
  ),
  actual AS (
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      le.kind AS direction,
      COALESCE(le.category, '') AS category,
      SUM(CASE WHEN le.kind = 'transfer' THEN
        CASE
          WHEN le.currency = $1 THEN le.amount::double precision
          WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
          ELSE NULL
        END
      ELSE
        CASE
          WHEN le.kind = 'spend' THEN -(
            CASE
              WHEN le.currency = $1 THEN le.amount::double precision
              WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
              ELSE NULL
            END
          )
          ELSE
            CASE
              WHEN le.currency = $1 THEN le.amount::double precision
              WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
              ELSE NULL
            END
        END
      END) AS actual,
      bool_or(le.currency != $1 AND r.rate IS NULL) AS has_unconvertible
    FROM ledger_entries le
    LEFT JOIN fx_rates_daily r
      ON r.quote_currency = $1
      AND r.base_currency = le.currency
      AND r.calendar_date = le.ts::date
    WHERE le.ts::date >= to_date($2, 'YYYY-MM')
      AND le.ts::date < (LEAST(to_date($3, 'YYYY-MM'), to_date($5, 'YYYY-MM')) + interval '1 month')::date
    GROUP BY 1, 2, 3
  )
  SELECT
    COALESCE(p.month, a.month) AS month,
    COALESCE(p.direction, a.direction) AS direction,
    COALESCE(p.category, a.category) AS category,
    COALESCE(p.planned_base, 0) AS planned_base,
    COALESCE(p.planned_modifier, 0) AS planned_modifier,
    COALESCE(p.planned_base, 0) + COALESCE(p.planned_modifier, 0) AS planned,
    COALESCE(a.actual, 0) AS actual,
    COALESCE(a.has_unconvertible, FALSE) AS has_unconvertible
  FROM planned p
  FULL OUTER JOIN actual a
    USING (month, direction, category)
  ORDER BY month, direction, category
`;

export const CUMULATIVE_BALANCE_QUERY = `
  WITH actual_before AS (
    SELECT
      le.kind AS direction,
      SUM(CASE WHEN le.kind = 'transfer' THEN
        CASE
          WHEN le.currency = $1 THEN le.amount::double precision
          WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
          ELSE NULL
        END
      ELSE
        CASE
          WHEN le.kind = 'spend' THEN -(
            CASE
              WHEN le.currency = $1 THEN le.amount::double precision
              WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
              ELSE NULL
            END
          )
          ELSE
            CASE
              WHEN le.currency = $1 THEN le.amount::double precision
              WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
              ELSE NULL
            END
        END
      END) AS total
    FROM ledger_entries le
    LEFT JOIN fx_rates_daily r
      ON r.quote_currency = $1
      AND r.base_currency = le.currency
      AND r.calendar_date = le.ts::date
    WHERE le.ts::date < to_date($2, 'YYYY-MM')
    GROUP BY direction
  )
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'income' THEN total END), 0) AS income_actual,
    COALESCE(SUM(CASE WHEN direction = 'spend' THEN total END), 0) AS spend_actual,
    COALESCE(SUM(CASE WHEN direction = 'transfer' THEN total END), 0) AS transfer_actual
  FROM actual_before
`;

const WARNINGS_QUERY = `
  WITH latest_day AS (
    SELECT MAX(calendar_date) AS calendar_date
    FROM fx_rates_daily
  ),
  data_currencies AS (
    SELECT DISTINCT currency FROM budget_lines
    UNION
    SELECT DISTINCT currency FROM ledger_entries
  ),
  rate_currencies AS (
    SELECT DISTINCT base_currency
    FROM fx_rates_daily
    WHERE quote_currency = $1
      AND calendar_date = (SELECT calendar_date FROM latest_day)
  )
  SELECT dc.currency
  FROM data_currencies dc
  LEFT JOIN rate_currencies rc ON rc.base_currency = dc.currency
  WHERE dc.currency != $1
    AND rc.base_currency IS NULL
  ORDER BY dc.currency
`;

export const MONTH_END_BALANCES_QUERY = `
  WITH
  monthly_deltas AS (
    -- Use le.currency directly instead of JOIN accounts view. The accounts view
    -- does MODE() WITHIN GROUP over the entire ledger_entries table to derive
    -- the "canonical" currency per account — this triggers a redundant full scan
    -- of ledger_entries plus a hash join back to itself. Each ledger entry already
    -- carries its own currency, so we use it directly.
    -- LEFT JOIN account_metadata to get per-account liquidity tier.
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      le.currency,
      COALESCE(am.liquidity, 'high') AS liquidity,
      SUM(le.amount::double precision) AS delta
    FROM ledger_entries le
    LEFT JOIN account_metadata am
      ON am.account_id = le.account_id AND am.workspace_id = le.workspace_id
    GROUP BY 1, 2, 3
  ),
  all_months AS (
    SELECT to_char(d::date, 'YYYY-MM') AS month
    FROM generate_series(
      (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_deltas),
      (date_trunc('month', to_date($3, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
      interval '1 month'
    ) d
  ),
  valuation_dates AS (
    SELECT
      month,
      LEAST(
        (date_trunc('month', to_date(month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
        to_date($4, 'YYYY-MM-DD')
      ) AS valuation_date
    FROM all_months
  ),
  currency_liquidities AS (
    SELECT DISTINCT currency, liquidity FROM monthly_deltas
  ),
  full_grid AS (
    SELECT m.month, cl.currency, cl.liquidity, COALESCE(d.delta, 0) AS delta
    FROM all_months m
    CROSS JOIN currency_liquidities cl
    LEFT JOIN monthly_deltas d ON d.month = m.month AND d.currency = cl.currency AND d.liquidity = cl.liquidity
  ),
  running_balances AS (
    SELECT month, currency, liquidity,
      SUM(delta) OVER (
        PARTITION BY currency, liquidity ORDER BY month
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS balance
    FROM full_grid
  )
  SELECT
    rb.month,
    rb.liquidity,
    ROUND(SUM(CASE
      WHEN rb.currency = $1 THEN rb.balance
      WHEN rr.rate IS NOT NULL THEN rb.balance * rr.rate::double precision
      ELSE NULL
    END)::numeric, 2) AS balance_report
  FROM running_balances rb
  JOIN valuation_dates vd
    ON vd.month = rb.month
  LEFT JOIN fx_rates_daily rr
    ON rr.quote_currency = $1
    AND rr.base_currency = rb.currency
    AND rr.calendar_date = vd.valuation_date
  WHERE rb.month >= to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
    AND rb.month <= $3
  GROUP BY rb.month, rb.liquidity
  ORDER BY rb.month, rb.liquidity
`;

export const BUSINESS_PERSONAL_TRANSFER_QUERY = `
  WITH transfer_rows AS (
    SELECT
      le.event_id,
      le.ts,
      COALESCE(am.account_type, 'personal') AS account_type,
      CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END AS amount_report,
      le.currency != $1 AND r.rate IS NULL AS has_unconvertible
    FROM ledger_entries le
    LEFT JOIN account_metadata am
      ON am.account_id = le.account_id AND am.workspace_id = le.workspace_id
    LEFT JOIN fx_rates_daily r
      ON r.quote_currency = $1
      AND r.base_currency = le.currency
      AND r.calendar_date = le.ts::date
    WHERE le.kind = 'transfer'
      AND le.ts::date >= to_date($2, 'YYYY-MM')
      AND le.ts::date < (LEAST(to_date($3, 'YYYY-MM'), to_date($4, 'YYYY-MM')) + interval '1 month')::date
  ),
  eligible_events AS (
    SELECT event_id
    FROM transfer_rows
    GROUP BY event_id
    HAVING bool_or(account_type = 'business')
       AND bool_or(account_type = 'personal')
  )
  SELECT
    to_char(tr.ts::date, 'YYYY-MM') AS month,
    COALESCE(SUM(CASE WHEN tr.account_type = 'personal' THEN tr.amount_report ELSE 0 END), 0) AS actual,
    bool_or(tr.account_type = 'personal' AND tr.has_unconvertible) AS has_unconvertible
  FROM transfer_rows tr
  JOIN eligible_events ee ON ee.event_id = tr.event_id
  GROUP BY 1
  ORDER BY 1
`;

const HAS_BUSINESS_ACCOUNT_QUERY = `
  SELECT EXISTS (
    SELECT 1
    FROM accounts a
    JOIN account_metadata am
      ON am.account_id = a.account_id
     AND am.workspace_id = current_setting('app.workspace_id', true)
    WHERE am.account_type = 'business'
  ) AS has_business_account
`;

type CumulativeRaw = Readonly<{
  income_actual: number;
  spend_actual: number;
  transfer_actual: number;
}>;

export const getBudgetGrid = async (userId: string, workspaceId: string, monthFrom: string, monthTo: string, planFrom: string, actualTo: string): Promise<BudgetGridResult> => {
  const [reportCurrency, latestFxCalendarDate] = await Promise.all([
    getReportCurrency(userId, workspaceId),
    getLatestFxCalendarDate(),
  ]);

  // Each queryAs acquires its own connection from the pool and sets RLS context
  // independently, so Promise.all runs all 4 queries on separate connections
  // in true DB-level parallel. The old withUserContext shared one connection,
  // which serialized all queries despite Promise.all (a single pg.Client can
  // only execute one query at a time).
  const [
    rowsResult,
    warningResult,
    cumulativeResult,
    balanceResult,
    businessPersonalTransferResult,
    hasBusinessAccountResult,
  ] = await Promise.all([
    queryAs(userId, workspaceId, QUERY, [reportCurrency, monthFrom, monthTo, planFrom, actualTo]),
    queryAs(userId, workspaceId, WARNINGS_QUERY, [reportCurrency]),
    queryAs(userId, workspaceId, CUMULATIVE_BALANCE_QUERY, [reportCurrency, monthFrom]),
    queryAs(userId, workspaceId, MONTH_END_BALANCES_QUERY, [reportCurrency, monthFrom, actualTo, latestFxCalendarDate]),
    queryAs(userId, workspaceId, BUSINESS_PERSONAL_TRANSFER_QUERY, [reportCurrency, monthFrom, monthTo, actualTo]),
    queryAs(userId, workspaceId, HAS_BUSINESS_ACCOUNT_QUERY, []),
  ]);

  const cumulative: CumulativeRaw = cumulativeResult.rows[0] as CumulativeRaw;

  const monthEndBalances: Record<string, number> = {};
  const monthEndBalancesByLiquidity: Record<string, Record<string, number>> = {};
  for (const row of balanceResult.rows as ReadonlyArray<{ month: string; liquidity: string; balance_report: string }>) {
    const value = Number(row.balance_report);
    monthEndBalances[row.month] = (monthEndBalances[row.month] ?? 0) + value;
    if (!(row.month in monthEndBalancesByLiquidity)) {
      monthEndBalancesByLiquidity[row.month] = {};
    }
    monthEndBalancesByLiquidity[row.month][row.liquidity] = value;
  }

  const businessPersonalTransfers: Record<string, BusinessPersonalTransferCell> = {};
  for (const row of businessPersonalTransferResult.rows as ReadonlyArray<{ month: string; actual: string; has_unconvertible: boolean }>) {
    businessPersonalTransfers[row.month] = {
      actual: Number(row.actual),
      hasUnconvertible: row.has_unconvertible,
    };
  }

  const hasBusinessAccountRow = hasBusinessAccountResult.rows[0] as { has_business_account: boolean } | undefined;
  if (hasBusinessAccountRow === undefined) {
    throw new Error("Failed to load business account state: query returned no row");
  }

  return {
    rows: rowsResult.rows.map((row: { month: string; direction: string; category: string; planned_base: number; planned_modifier: number; planned: number; actual: number; has_unconvertible: boolean }) => ({
      month: row.month,
      direction: row.direction,
      category: row.category,
      plannedBase: Number(row.planned_base),
      plannedModifier: Number(row.planned_modifier),
      planned: Number(row.planned),
      actual: Number(row.actual),
      hasUnconvertible: row.has_unconvertible,
    })),
    conversionWarnings: warningResult.rows.map((row: { currency: string }) => ({
      currency: row.currency,
      reason: `No exchange rates available for ${row.currency}`,
    })),
    cumulativeBefore: {
      incomeActual: Number(cumulative.income_actual),
      spendActual: Number(cumulative.spend_actual),
      transferActual: Number(cumulative.transfer_actual),
    },
    monthEndBalances,
    monthEndBalancesByLiquidity,
    businessPersonalTransfers,
    hasBusinessAccount: hasBusinessAccountRow.has_business_account,
  };
};
