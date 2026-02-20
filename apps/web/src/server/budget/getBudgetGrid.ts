import { query } from "@/server/db";
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

export type BudgetGridResult = Readonly<{
  rows: ReadonlyArray<BudgetRow>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
  cumulativeBefore: CumulativeBefore;
  /**
   * Actual portfolio balance in report currency at the end of each month, keyed by "YYYY-MM".
   * Computed as: running native-currency balance per currency, converted at the
   * exchange rate closest to month-end (mark-to-market). Covers months from one
   * month before monthFrom up to actualTo. Used by the UI to anchor the
   * Balance row to reality and derive the per-month FX adjustment.
   */
  monthEndBalances: Readonly<Record<string, number>>;
}>;

const QUERY = `
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
  rate_ranges AS (
    SELECT
      base_currency, rate_date, rate,
      LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
    FROM exchange_rates
    WHERE quote_currency = $1
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
        ABS(CASE
          WHEN le.currency = $1 THEN le.amount::double precision
          WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
          ELSE NULL
        END)
      END) AS actual,
      bool_or(le.currency != $1 AND r.rate IS NULL) AS has_unconvertible
    FROM ledger_entries le
    LEFT JOIN rate_ranges r
      ON r.base_currency = le.currency
      AND le.ts::date >= r.rate_date
      AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
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

const CUMULATIVE_BALANCE_QUERY = `
  WITH rate_ranges AS (
    SELECT
      base_currency, rate_date, rate,
      LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
    FROM exchange_rates
    WHERE quote_currency = $1
  ),
  actual_before AS (
    SELECT
      le.kind AS direction,
      SUM(CASE WHEN le.kind = 'transfer' THEN
        CASE
          WHEN le.currency = $1 THEN le.amount::double precision
          WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
          ELSE NULL
        END
      ELSE
        ABS(CASE
          WHEN le.currency = $1 THEN le.amount::double precision
          WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
          ELSE NULL
        END)
      END) AS total
    FROM ledger_entries le
    LEFT JOIN rate_ranges r
      ON r.base_currency = le.currency
      AND le.ts::date >= r.rate_date
      AND (le.ts::date < r.next_rate_date OR r.next_rate_date IS NULL)
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
  WITH data_currencies AS (
    SELECT DISTINCT currency FROM budget_lines
    UNION
    SELECT DISTINCT currency FROM ledger_entries
  ),
  rate_currencies AS (
    SELECT DISTINCT base_currency
    FROM exchange_rates
    WHERE quote_currency = $1
  )
  SELECT dc.currency
  FROM data_currencies dc
  LEFT JOIN rate_currencies rc ON rc.base_currency = dc.currency
  WHERE dc.currency != $1
    AND rc.base_currency IS NULL
  ORDER BY dc.currency
`;

const MONTH_END_BALANCES_QUERY = `
  WITH
  monthly_deltas AS (
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      a.currency,
      SUM(le.amount::double precision) AS delta
    FROM ledger_entries le
    JOIN accounts a ON a.account_id = le.account_id
    GROUP BY 1, 2
  ),
  all_months AS (
    SELECT to_char(d::date, 'YYYY-MM') AS month
    FROM generate_series(
      (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_deltas),
      (date_trunc('month', to_date($3, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
      interval '1 month'
    ) d
  ),
  currencies AS (
    SELECT DISTINCT currency FROM monthly_deltas
  ),
  full_grid AS (
    SELECT m.month, c.currency, COALESCE(d.delta, 0) AS delta
    FROM all_months m
    CROSS JOIN currencies c
    LEFT JOIN monthly_deltas d ON d.month = m.month AND d.currency = c.currency
  ),
  running_balances AS (
    SELECT month, currency,
      SUM(delta) OVER (
        PARTITION BY currency ORDER BY month
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS balance
    FROM full_grid
  ),
  rate_ranges AS (
    SELECT base_currency, rate_date, rate,
      LEAD(rate_date) OVER (PARTITION BY base_currency ORDER BY rate_date) AS next_rate_date
    FROM exchange_rates
    WHERE quote_currency = $1
  )
  SELECT
    rb.month,
    ROUND(SUM(CASE
      WHEN rb.currency = $1 THEN rb.balance
      WHEN rr.rate IS NOT NULL THEN rb.balance * rr.rate::double precision
      ELSE NULL
    END)::numeric, 2) AS balance_report
  FROM running_balances rb
  LEFT JOIN rate_ranges rr
    ON rr.base_currency = rb.currency
    AND (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date >= rr.rate_date
    AND ((date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date < rr.next_rate_date
         OR rr.next_rate_date IS NULL)
  WHERE rb.month >= to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
    AND rb.month <= $3
  GROUP BY rb.month
  ORDER BY rb.month
`;

type CumulativeRaw = Readonly<{
  income_actual: number;
  spend_actual: number;
  transfer_actual: number;
}>;

export const getBudgetGrid = async (monthFrom: string, monthTo: string, planFrom: string, actualTo: string): Promise<BudgetGridResult> => {
  const reportCurrency = await getReportCurrency();

  const [rowsResult, warningResult, cumulativeResult, balanceResult] = await Promise.all([
    query(QUERY, [reportCurrency, monthFrom, monthTo, planFrom, actualTo]),
    query(WARNINGS_QUERY, [reportCurrency]),
    query(CUMULATIVE_BALANCE_QUERY, [reportCurrency, monthFrom]),
    query(MONTH_END_BALANCES_QUERY, [reportCurrency, monthFrom, actualTo]),
  ]);

  const cumulative: CumulativeRaw = cumulativeResult.rows[0] as CumulativeRaw;

  const monthEndBalances: Record<string, number> = {};
  for (const row of balanceResult.rows as ReadonlyArray<{ month: string; balance_report: string }>) {
    monthEndBalances[row.month] = Number(row.balance_report);
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
  };
};
