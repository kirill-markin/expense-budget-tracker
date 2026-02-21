/**
 * Account balances summary for the balances dashboard.
 *
 * Runs four parallel queries inside a single user-scoped transaction:
 * 1. ACCOUNTS — per-account balance in native + report currency, last non-transfer timestamp.
 * 2. TOTALS — aggregated balance per currency with positive/negative split.
 * 3. WARNINGS — currencies present in data but missing exchange rates.
 * 4. STALENESS — P75 inter-transaction gap stats for overdue detection.
 *
 * FX conversion uses the latest available rate per currency from exchange_rates.
 * Accounts are classified as active/inactive based on balance and 90-day activity.
 */
import { withUserContext } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";
import { type StalenessInput, isAccountOverdue } from "@/server/balances/accountStaleness";

export type AccountRow = Readonly<{
  accountId: string;
  currency: string;
  status: string;
  balance: number;
  balanceUsd: number | null;
  lastTransactionTs: string | null;
  overdue: boolean;
}>;

export type CurrencyTotal = Readonly<{
  currency: string;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  balanceUsd: number | null;
  hasUnconvertible: boolean;
}>;

export type ConversionWarning = Readonly<{
  currency: string;
  reason: string;
}>;

export type BalancesSummaryResult = Readonly<{
  accounts: ReadonlyArray<AccountRow>;
  totals: ReadonlyArray<CurrencyTotal>;
  conversionWarnings: ReadonlyArray<ConversionWarning>;
}>;

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function computeAccountStatus(
  balance: number,
  lastTransactionTs: string | null,
): "active" | "inactive" {
  if (balance !== 0) return "active";
  if (lastTransactionTs === null) return "inactive";
  const diffMs = Date.now() - new Date(lastTransactionTs).getTime();
  return diffMs > THREE_MONTHS_MS ? "inactive" : "active";
}

const ACCOUNTS_QUERY = `
  WITH max_rate_dates AS (
    SELECT base_currency, MAX(rate_date) AS rate_date
    FROM exchange_rates
    WHERE quote_currency = $1
    GROUP BY base_currency
  ),
  latest_rates AS (
    SELECT er.base_currency, er.rate
    FROM exchange_rates er
    INNER JOIN max_rate_dates mrd
      ON mrd.base_currency = er.base_currency
      AND mrd.rate_date = er.rate_date
    WHERE er.quote_currency = $1
  )
  SELECT
    a.account_id,
    a.currency,
    COALESCE(SUM(le.amount)::double precision, 0) AS balance,
    CASE
      WHEN a.currency = $1 THEN COALESCE(SUM(le.amount)::double precision, 0)
      WHEN lr.rate IS NOT NULL THEN COALESCE(SUM(le.amount)::double precision, 0) * lr.rate::double precision
      ELSE NULL
    END AS balance_report,
    MAX(CASE WHEN le.kind != 'transfer' THEN le.ts END) AS last_transaction_ts
  FROM accounts a
  LEFT JOIN ledger_entries le ON le.account_id = a.account_id
  LEFT JOIN latest_rates lr ON lr.base_currency = a.currency
  GROUP BY a.account_id, a.currency, lr.rate
  ORDER BY a.account_id
`;

const TOTALS_QUERY = `
  WITH account_balances AS (
    SELECT
      a.account_id,
      a.currency,
      COALESCE(SUM(le.amount)::double precision, 0) AS balance
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.account_id
    GROUP BY a.account_id, a.currency
  ),
  max_rate_dates AS (
    SELECT base_currency, MAX(rate_date) AS rate_date
    FROM exchange_rates
    WHERE quote_currency = $1
    GROUP BY base_currency
  ),
  latest_rates AS (
    SELECT er.base_currency, er.rate
    FROM exchange_rates er
    INNER JOIN max_rate_dates mrd
      ON mrd.base_currency = er.base_currency
      AND mrd.rate_date = er.rate_date
    WHERE er.quote_currency = $1
  )
  SELECT
    ab.currency,
    SUM(ab.balance) AS balance,
    SUM(CASE WHEN ab.balance > 0 THEN ab.balance ELSE 0 END) AS balance_positive,
    SUM(CASE WHEN ab.balance < 0 THEN ab.balance ELSE 0 END) AS balance_negative,
    SUM(CASE
      WHEN ab.currency = $1 THEN ab.balance
      ELSE ab.balance * lr.rate::double precision
    END) AS balance_report,
    bool_or(ab.currency != $1 AND lr.rate IS NULL) AS has_unconvertible
  FROM account_balances ab
  LEFT JOIN latest_rates lr ON lr.base_currency = ab.currency
  GROUP BY ab.currency
  ORDER BY ab.currency
`;

const STALENESS_QUERY = `
  WITH txns AS (
    SELECT account_id, ts,
      LAG(ts) OVER (PARTITION BY account_id ORDER BY ts) AS prev_ts
    FROM ledger_entries
    WHERE kind != 'transfer'
  ),
  nonzero_gaps AS (
    SELECT account_id,
      EXTRACT(EPOCH FROM (ts - prev_ts)) / 86400 AS gap_days,
      ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY ts DESC) AS rn
    FROM txns
    WHERE prev_ts IS NOT NULL
      AND ts != prev_ts
  ),
  stats AS (
    SELECT account_id,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY gap_days) AS p75_recent_gap_days
    FROM nonzero_gaps
    WHERE rn <= 20
    GROUP BY account_id
  ),
  counts AS (
    SELECT account_id, COUNT(*) AS total_non_transfer_txns
    FROM ledger_entries
    WHERE kind != 'transfer'
    GROUP BY account_id
  ),
  counts_30d AS (
    SELECT account_id, COUNT(*) AS recent_non_transfer_txns_30d
    FROM ledger_entries
    WHERE kind != 'transfer'
      AND ts >= now() - interval '30 days'
    GROUP BY account_id
  )
  SELECT
    c.account_id,
    c.total_non_transfer_txns,
    COALESCE(c30.recent_non_transfer_txns_30d, 0) AS recent_non_transfer_txns_30d,
    s.p75_recent_gap_days
  FROM counts c
  LEFT JOIN counts_30d c30 ON c30.account_id = c.account_id
  LEFT JOIN stats s ON s.account_id = c.account_id
`;

const WARNINGS_QUERY = `
  WITH data_currencies AS (
    SELECT DISTINCT currency
    FROM accounts
    WHERE currency != $1
  ),
  rate_currencies AS (
    SELECT DISTINCT base_currency
    FROM exchange_rates
    WHERE quote_currency = $1
  )
  SELECT dc.currency
  FROM data_currencies dc
  LEFT JOIN rate_currencies rc ON rc.base_currency = dc.currency
  WHERE rc.base_currency IS NULL
  ORDER BY dc.currency
`;

export const getBalancesSummary = async (userId: string): Promise<BalancesSummaryResult> => {
  const reportCurrency = await getReportCurrency(userId);

  return withUserContext(userId, async (q) => {
    const [accountResult, totalResult, warningResult, stalenessResult] = await Promise.all([
      q(ACCOUNTS_QUERY, [reportCurrency]),
      q(TOTALS_QUERY, [reportCurrency]),
      q(WARNINGS_QUERY, [reportCurrency]),
      q(STALENESS_QUERY, []),
    ]);

    const stalenessMap = new Map<string, StalenessInput>();
    for (const row of stalenessResult.rows as ReadonlyArray<{
      account_id: string;
      total_non_transfer_txns: string;
      recent_non_transfer_txns_30d: string;
      p75_recent_gap_days: number | null;
    }>) {
      stalenessMap.set(row.account_id, {
        totalNonTransferTxns: Number(row.total_non_transfer_txns),
        recentNonTransferTxns30d: Number(row.recent_non_transfer_txns_30d),
        p75RecentGapDays: row.p75_recent_gap_days !== null ? Number(row.p75_recent_gap_days) : null,
        daysSinceLast: null,
      });
    }

    return {
      accounts: accountResult.rows.map((row: {
        account_id: string;
        currency: string;
        balance: number;
        balance_report: number | null;
        last_transaction_ts: string | null;
      }) => {
        const lastTransactionTs = row.last_transaction_ts !== null
          ? new Date(row.last_transaction_ts).toISOString()
          : null;
        const daysSinceLast = lastTransactionTs !== null
          ? Math.floor((Date.now() - new Date(lastTransactionTs).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        const staleness = stalenessMap.get(row.account_id);
        const overdue = staleness !== undefined
          ? isAccountOverdue({ ...staleness, daysSinceLast })
          : false;
        return {
          accountId: row.account_id,
          currency: row.currency,
          status: computeAccountStatus(Number(row.balance), lastTransactionTs),
          balance: Number(row.balance),
          balanceUsd: row.balance_report !== null ? Number(row.balance_report) : null,
          lastTransactionTs,
          overdue,
        };
      }),
      totals: totalResult.rows.map((row: {
        currency: string;
        balance: number;
        balance_positive: number;
        balance_negative: number;
        balance_report: number | null;
        has_unconvertible: boolean;
      }) => ({
        currency: row.currency,
        balance: Number(row.balance),
        balancePositive: Number(row.balance_positive),
        balanceNegative: Number(row.balance_negative),
        balanceUsd: row.balance_report !== null ? Number(row.balance_report) : null,
        hasUnconvertible: row.has_unconvertible,
      })),
      conversionWarnings: warningResult.rows.map((row: { currency: string }) => ({
        currency: row.currency,
        reason: `No exchange rates found for ${row.currency}`,
      })),
    };
  });
};
