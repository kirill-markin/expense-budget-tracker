import { queryAs } from "@/server/db";
import { getLatestFxCalendarDate } from "@/server/fxRates";
import { getReportCurrency } from "@/server/reportCurrency";
import { getMonthEndDate, offsetMonth } from "@/lib/monthUtils";

/**
 * Per-currency FX breakdown for a single month.
 * Shows how each currency's balance changed between previous and current month-end,
 * valued at the respective month-end exchange rates (mark-to-market).
 *
 * The worker already expanded raw rates into exact-date all-pairs rows, so
 * this query only joins the required month-end dates from fx_rates_daily.
 */
export type FxBreakdownRow = Readonly<{
  currency: string;
  openNative: number;
  openRate: number;
  openReport: number;
  deltaNative: number;
  flowReport: number;
  closeNative: number;
  closeRate: number;
  closeReport: number;
  changeReport: number;
  fxAdjustReport: number;
}>;

export type FxBreakdownResult = Readonly<{
  rows: ReadonlyArray<FxBreakdownRow>;
  openValuationDate: string;
  closeValuationDate: string;
}>;

/**
 * Per-currency FX breakdown for a given month.
 *
 * For each currency, returns:
 * - Opening balance (native + report-currency at previous month-end rate)
 * - Delta (native-currency flow during the month)
 * - Flow in report currency, converted on each ledger entry date
 * - Closing balance (native + report-currency at current month-end rate)
 * - Change in report currency (close - open)
 * - FX adjustment in report currency (close - open - flow)
 *
 * The sum of all change values equals monthEndBalance(M) - monthEndBalance(M-1).
 * The difference between that sum and the budget delta is the FX adjustment.
 */
export const QUERY = `
  WITH
  monthly_native_deltas AS (
    -- Use le.currency directly instead of JOIN accounts view
    -- (see getBudgetGrid.ts MONTH_END_BALANCES comment for rationale).
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      le.currency,
      SUM(le.amount::double precision) AS delta_native
    FROM ledger_entries le
    GROUP BY 1, 2
  ),
  monthly_report_flows AS (
    SELECT
      to_char(le.ts::date, 'YYYY-MM') AS month,
      le.currency,
      SUM(CASE
        WHEN le.currency = $1 THEN le.amount::double precision
        WHEN r.rate IS NOT NULL THEN le.amount::double precision * r.rate::double precision
        ELSE NULL
      END) AS flow_report
    FROM ledger_entries le
    LEFT JOIN fx_rates_daily r
      ON r.quote_currency = $1
      AND r.base_currency = le.currency
      AND r.calendar_date = le.ts::date
    GROUP BY 1, 2
  ),
  all_months AS (
    SELECT to_char(d::date, 'YYYY-MM') AS month
    FROM generate_series(
      (SELECT MIN(to_date(month, 'YYYY-MM')) FROM monthly_native_deltas),
      (date_trunc('month', to_date($2, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
      interval '1 month'
    ) d
  ),
  valuation_dates AS (
    SELECT
      month,
      LEAST(
        (date_trunc('month', to_date(month, 'YYYY-MM')) + interval '1 month' - interval '1 day')::date,
        to_date($3, 'YYYY-MM-DD')
      ) AS valuation_date
    FROM all_months
  ),
  currencies AS (
    SELECT DISTINCT currency FROM monthly_native_deltas
  ),
  full_grid AS (
    SELECT
      m.month,
      c.currency,
      COALESCE(nd.delta_native, 0) AS delta_native,
      COALESCE(rf.flow_report, 0) AS flow_report
    FROM all_months m
    CROSS JOIN currencies c
    LEFT JOIN monthly_native_deltas nd
      ON nd.month = m.month AND nd.currency = c.currency
    LEFT JOIN monthly_report_flows rf
      ON rf.month = m.month AND rf.currency = c.currency
  ),
  running_balances AS (
    SELECT
      month,
      currency,
      SUM(delta_native) OVER (
        PARTITION BY currency ORDER BY month
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS balance,
      delta_native,
      flow_report
    FROM full_grid
  ),
  prev AS (
    SELECT rb.currency, rb.balance,
      CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
    FROM running_balances rb
    JOIN valuation_dates vd
      ON vd.month = rb.month
    LEFT JOIN fx_rates_daily rr
      ON rr.quote_currency = $1
      AND rr.base_currency = rb.currency
      AND rr.calendar_date = vd.valuation_date
    WHERE rb.month = to_char(to_date($2, 'YYYY-MM') - interval '1 month', 'YYYY-MM')
  ),
  curr AS (
    SELECT rb.currency, rb.balance, rb.delta_native, rb.flow_report,
      CASE WHEN rb.currency = $1 THEN 1.0 ELSE rr.rate::double precision END AS rate
    FROM running_balances rb
    JOIN valuation_dates vd
      ON vd.month = rb.month
    LEFT JOIN fx_rates_daily rr
      ON rr.quote_currency = $1
      AND rr.base_currency = rb.currency
      AND rr.calendar_date = vd.valuation_date
    WHERE rb.month = $2
  )
  SELECT
    COALESCE(c.currency, p.currency) AS currency,
    ROUND(COALESCE(p.balance, 0)::numeric, 2) AS open_native,
    ROUND(COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS open_rate,
    ROUND((COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS open_report,
    ROUND(COALESCE(c.delta_native, 0)::numeric, 2) AS delta_native,
    ROUND(COALESCE(c.flow_report, 0)::numeric, 2) AS flow_report,
    ROUND(COALESCE(c.balance, COALESCE(p.balance, 0))::numeric, 2) AS close_native,
    ROUND(COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END)::numeric, 6) AS close_rate,
    ROUND((COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END))::numeric, 2) AS close_report,
    ROUND((
      COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
      COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END)
    )::numeric, 2) AS change_report,
    ROUND((
      COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
      COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END) -
      COALESCE(c.flow_report, 0)
    )::numeric, 2) AS fx_adjust_report
  FROM curr c
  FULL OUTER JOIN prev p USING (currency)
  WHERE ABS(COALESCE(c.balance, COALESCE(p.balance, 0))) > 0.01
     OR ABS(COALESCE(p.balance, 0)) > 0.01
  ORDER BY ABS(
    COALESCE(c.balance, COALESCE(p.balance, 0)) * COALESCE(c.rate, CASE WHEN COALESCE(c.currency, p.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(p.balance, 0) * COALESCE(p.rate, CASE WHEN COALESCE(p.currency, c.currency) = $1 THEN 1.0 ELSE 0 END) -
    COALESCE(c.flow_report, 0)
  ) DESC
`;

type RawRow = Readonly<{
  currency: string;
  open_native: string;
  open_rate: string;
  open_report: string;
  delta_native: string;
  flow_report: string;
  close_native: string;
  close_rate: string;
  close_report: string;
  change_report: string;
  fx_adjust_report: string;
}>;

const getValuationDate = (month: string, latestFxCalendarDate: string): string => {
  const monthEndDate = getMonthEndDate(month);
  return monthEndDate < latestFxCalendarDate ? monthEndDate : latestFxCalendarDate;
};

export const getFxBreakdown = async (userId: string, workspaceId: string, month: string): Promise<FxBreakdownResult> => {
  const [reportCurrency, latestFxCalendarDate] = await Promise.all([
    getReportCurrency(userId, workspaceId),
    getLatestFxCalendarDate(),
  ]);
  const result = await queryAs(userId, workspaceId, QUERY, [reportCurrency, month, latestFxCalendarDate]);
  const openValuationDate = getValuationDate(offsetMonth(month, -1), latestFxCalendarDate);
  const closeValuationDate = getValuationDate(month, latestFxCalendarDate);
  return {
    openValuationDate,
    closeValuationDate,
    rows: (result.rows as ReadonlyArray<RawRow>).map((row) => ({
      currency: row.currency,
      openNative: Number(row.open_native),
      openRate: Number(row.open_rate),
      openReport: Number(row.open_report),
      deltaNative: Number(row.delta_native),
      flowReport: Number(row.flow_report),
      closeNative: Number(row.close_native),
      closeRate: Number(row.close_rate),
      closeReport: Number(row.close_report),
      changeReport: Number(row.change_report),
      fxAdjustReport: Number(row.fx_adjust_report),
    })),
  };
};
