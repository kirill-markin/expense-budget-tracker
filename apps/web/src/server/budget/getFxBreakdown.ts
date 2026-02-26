import { queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";

/**
 * Per-currency FX breakdown for a single month.
 * Shows how each currency's balance changed between previous and current month-end,
 * valued at the respective month-end exchange rates (mark-to-market).
 *
 * Performance: uses le.currency directly (not the accounts view) and LATERAL
 * index lookups for FX rates (not the rate_ranges CTE). See getBudgetGrid.ts
 * module docstring for rationale.
 */
export type FxBreakdownRow = Readonly<{
  currency: string;
  openNative: number;
  openRate: number;
  openUsd: number;
  deltaNative: number;
  closeNative: number;
  closeRate: number;
  closeUsd: number;
  changeUsd: number;
}>;

export type FxBreakdownResult = Readonly<{
  rows: ReadonlyArray<FxBreakdownRow>;
}>;

/**
 * Per-currency FX breakdown for a given month.
 *
 * For each currency, returns:
 * - Opening balance (native + report-currency at previous month-end rate)
 * - Delta (native-currency flow during the month)
 * - Closing balance (native + report-currency at current month-end rate)
 * - Change in report currency (close - open)
 *
 * The sum of all change values equals monthEndBalance(M) - monthEndBalance(M-1).
 * The difference between that sum and the budget delta is the FX adjustment.
 */
const QUERY = `
  WITH
  monthly_deltas AS (
    -- Use le.currency directly instead of JOIN accounts view
    -- (see getBudgetGrid.ts MONTH_END_BALANCES comment for rationale).
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      le.currency,
      SUM(le.amount::double precision) AS delta
    FROM ledger_entries le
    GROUP BY 1, 2
  ),
  all_months AS (
    SELECT to_char(d::date, 'YYYY-MM') AS month
    FROM generate_series(
      (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_deltas),
      (date_trunc('month', to_date($2, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
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
      ) AS balance,
      delta
    FROM full_grid
  ),
  prev AS (
    SELECT rb.currency, rb.balance,
      CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
    FROM running_balances rb
    -- LATERAL: one backward index scan per currency via
    -- idx_exchange_rates_quote_base_date (see getBudgetGrid.ts for rationale).
    LEFT JOIN LATERAL (
      SELECT rate FROM exchange_rates
      WHERE quote_currency = $1
        AND base_currency = rb.currency
        AND rate_date <= (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date
      ORDER BY rate_date DESC
      LIMIT 1
    ) rr ON true
    WHERE rb.month = to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
  ),
  curr AS (
    SELECT rb.currency, rb.balance, rb.delta,
      CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
    FROM running_balances rb
    LEFT JOIN LATERAL (
      SELECT rate FROM exchange_rates
      WHERE quote_currency = $1
        AND base_currency = rb.currency
        AND rate_date <= (date_trunc('month', to_date(rb.month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date
      ORDER BY rate_date DESC
      LIMIT 1
    ) rr ON true
    WHERE rb.month = $2
  )
  SELECT
    COALESCE(c.currency, p.currency) AS currency,
    ROUND(COALESCE(p.balance, 0)::numeric, 2) AS open_native,
    ROUND(COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS open_rate,
    ROUND((COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS open_report,
    ROUND(COALESCE(c.delta, 0)::numeric, 2) AS delta_native,
    ROUND(COALESCE(c.balance, COALESCE(p.balance, 0))::numeric, 2) AS close_native,
    ROUND(COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS close_rate,
    ROUND((COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS close_report,
    ROUND((
      COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
      COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
    )::numeric, 2) AS change_report
  FROM curr c
  FULL OUTER JOIN prev p USING (currency)
  WHERE ABS(COALESCE(c.balance, COALESCE(p.balance, 0))) > 0.01
     OR ABS(COALESCE(p.balance, 0)) > 0.01
  ORDER BY ABS(
    COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
  ) DESC
`;

type RawRow = Readonly<{
  currency: string;
  open_native: string;
  open_rate: string;
  open_report: string;
  delta_native: string;
  close_native: string;
  close_rate: string;
  close_report: string;
  change_report: string;
}>;

export const getFxBreakdown = async (userId: string, workspaceId: string, month: string): Promise<FxBreakdownResult> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  const result = await queryAs(userId, workspaceId, QUERY, [reportCurrency, month]);
  return {
    rows: (result.rows as ReadonlyArray<RawRow>).map((row) => ({
      currency: row.currency,
      openNative: Number(row.open_native),
      openRate: Number(row.open_rate),
      openUsd: Number(row.open_report),
      deltaNative: Number(row.delta_native),
      closeNative: Number(row.close_native),
      closeRate: Number(row.close_rate),
      closeUsd: Number(row.close_report),
      changeUsd: Number(row.change_report),
    })),
  };
};
