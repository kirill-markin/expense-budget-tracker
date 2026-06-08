/**
 * Account balances summary for the balances dashboard.
 *
 * Runs four parallel queries inside a single user-scoped transaction:
 * 1. ACCOUNTS — per-account balance in native + report currency, last non-transfer timestamp.
 * 2. TOTALS — aggregated balance per currency with positive/negative split.
 * 3. WARNINGS — currencies present in data but missing exchange rates.
 * 4. STALENESS — MAX inter-transaction gap stats for overdue detection.
 *
 * FX conversion uses the latest fully built day from fx_rates_daily.
 * Accounts are classified as active/inactive based on balance and 90-day activity.
 */
import {
  ACCOUNT_METADATA_DEFAULT_ACCOUNT_TYPE,
  ACCOUNT_METADATA_DEFAULT_GROUP,
  ACCOUNT_METADATA_DEFAULT_LIQUIDITY,
  type AccountMetadataAccountType,
  type AccountMetadataGroup,
  type AccountMetadataLiquidity,
  isAccountMetadataAccountType,
  isAccountMetadataGroup,
  isAccountMetadataLiquidity,
} from "@expense-budget-tracker/agent-shared";

import { withUserContext } from "@/server/db";
import { getLatestFxCalendarDate } from "@/server/fxRates";
import { getReportCurrency } from "@/server/reportCurrency";
import { type StalenessInput, isAccountOverdue } from "@/server/balances/accountStaleness";

export type AccountRow = Readonly<{
  accountId: string;
  currency: string;
  liquidity: AccountMetadataLiquidity;
  accountType: AccountMetadataAccountType;
  accountGroup: AccountMetadataGroup;
  status: string;
  balance: number;
  balanceReport: number | null;
  lastTransactionTs: string | null;
  overdue: boolean;
}>;

export type CurrencyTotal = Readonly<{
  currency: string;
  balance: number;
  balancePositive: number;
  balanceNegative: number;
  balanceReport: number | null;
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

export const ACCOUNTS_QUERY = `
  WITH latest_rates AS (
    SELECT base_currency, rate
    FROM fx_rates_daily
    WHERE quote_currency = $1
      AND calendar_date = $2
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

export const TOTALS_QUERY = `
  WITH account_balances AS (
    SELECT
      a.account_id,
      a.currency,
      COALESCE(SUM(le.amount)::double precision, 0) AS balance
    FROM accounts a
    LEFT JOIN ledger_entries le ON le.account_id = a.account_id
    GROUP BY a.account_id, a.currency
  ),
  latest_rates AS (
    SELECT base_currency, rate
    FROM fx_rates_daily
    WHERE quote_currency = $1
      AND calendar_date = $2
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
      MAX(gap_days) AS max_recent_gap_days
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
    s.max_recent_gap_days
  FROM counts c
  LEFT JOIN counts_30d c30 ON c30.account_id = c.account_id
  LEFT JOIN stats s ON s.account_id = c.account_id
`;

const METADATA_QUERY = `
  SELECT
    am.account_id,
    am.liquidity,
    COALESCE(to_jsonb(am)->>'account_type', $1) AS account_type,
    COALESCE(to_jsonb(am)->>'account_group', $2) AS account_group
  FROM account_metadata am
`;

export const WARNINGS_QUERY = `
  WITH latest_rates AS (
    SELECT DISTINCT base_currency
    FROM fx_rates_daily
    WHERE quote_currency = $1
      AND calendar_date = $2
  ),
  data_currencies AS (
    SELECT DISTINCT currency
    FROM accounts
    WHERE currency != $1
  )
  SELECT dc.currency
  FROM data_currencies dc
  LEFT JOIN latest_rates lr ON lr.base_currency = dc.currency
  WHERE lr.base_currency IS NULL
  ORDER BY dc.currency
`;

export const getBalancesSummary = async (userId: string, workspaceId: string): Promise<BalancesSummaryResult> => {
  const [reportCurrency, latestFxCalendarDate] = await Promise.all([
    getReportCurrency(userId, workspaceId),
    getLatestFxCalendarDate(),
  ]);

  return withUserContext(userId, workspaceId, async (q) => {
    const [accountResult, totalResult, warningResult, stalenessResult, metadataResult] = await Promise.all([
      q(ACCOUNTS_QUERY, [reportCurrency, latestFxCalendarDate]),
      q(TOTALS_QUERY, [reportCurrency, latestFxCalendarDate]),
      q(WARNINGS_QUERY, [reportCurrency, latestFxCalendarDate]),
      q(STALENESS_QUERY, []),
      q(METADATA_QUERY, [ACCOUNT_METADATA_DEFAULT_ACCOUNT_TYPE, ACCOUNT_METADATA_DEFAULT_GROUP]),
    ]);

    const metadataMap = new Map<string, Readonly<{
      liquidity: AccountMetadataLiquidity;
      accountType: AccountMetadataAccountType;
      accountGroup: AccountMetadataGroup;
    }>>();
    for (const row of metadataResult.rows as ReadonlyArray<{
      account_id: string;
      liquidity: string;
      account_type: string;
      account_group: string;
    }>) {
      metadataMap.set(row.account_id, {
        liquidity: parseLiquidity(row.account_id, row.liquidity),
        accountType: parseAccountType(row.account_id, row.account_type),
        accountGroup: parseAccountGroup(row.account_id, row.account_group),
      });
    }

    const stalenessMap = new Map<string, StalenessInput>();
    for (const row of stalenessResult.rows as ReadonlyArray<{
      account_id: string;
      total_non_transfer_txns: string;
      recent_non_transfer_txns_30d: string;
      max_recent_gap_days: number | null;
    }>) {
      stalenessMap.set(row.account_id, {
        totalNonTransferTxns: Number(row.total_non_transfer_txns),
        recentNonTransferTxns30d: Number(row.recent_non_transfer_txns_30d),
        maxRecentGapDays: row.max_recent_gap_days !== null ? Number(row.max_recent_gap_days) : null,
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
        const metadata = metadataMap.get(row.account_id);
        return {
          accountId: row.account_id,
          currency: row.currency,
          liquidity: metadata?.liquidity ?? ACCOUNT_METADATA_DEFAULT_LIQUIDITY,
          accountType: metadata?.accountType ?? ACCOUNT_METADATA_DEFAULT_ACCOUNT_TYPE,
          accountGroup: metadata?.accountGroup ?? ACCOUNT_METADATA_DEFAULT_GROUP,
          status: computeAccountStatus(Number(row.balance), lastTransactionTs),
          balance: Number(row.balance),
          balanceReport: row.balance_report !== null ? Number(row.balance_report) : null,
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
        balanceReport: row.balance_report !== null ? Number(row.balance_report) : null,
        hasUnconvertible: row.has_unconvertible,
      })),
      conversionWarnings: warningResult.rows.map((row: { currency: string }) => ({
        currency: row.currency,
        reason: `No exchange rates found for ${row.currency}`,
      })),
    };
  });
};

const parseLiquidity = (accountId: string, value: string): AccountMetadataLiquidity => {
  if (isAccountMetadataLiquidity(value)) return value;
  throw new Error(`Invalid account_metadata.liquidity "${value}" for account_id "${accountId}"`);
};

const parseAccountType = (accountId: string, value: string): AccountMetadataAccountType => {
  if (isAccountMetadataAccountType(value)) return value;
  throw new Error(`Invalid account_metadata.account_type "${value}" for account_id "${accountId}"`);
};

const parseAccountGroup = (accountId: string, value: string): AccountMetadataGroup => {
  if (isAccountMetadataGroup(value)) return value;
  throw new Error(`Invalid account_metadata.account_group "${value}" for account_id "${accountId}"`);
};
