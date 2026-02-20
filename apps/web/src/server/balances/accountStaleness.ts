/**
 * Smart staleness detection for financial accounts.
 *
 * Instead of a fixed "N days since last transaction" threshold, this module
 * detects when an account's silence is unusual *for that specific account*
 * based on its recent transaction rhythm.
 *
 * Algorithm — "Overdue P75, last 20":
 *
 * 1. Compute the 75th percentile (P75) of the last 20 non-zero
 *    inter-transaction gaps for each account (excluding transfers and
 *    same-day entries). Using "last 20" instead of full history makes the
 *    algorithm adapt when an account changes its usage pattern (e.g. from
 *    daily to monthly).
 *
 * 2. Flag the account as overdue when ALL conditions hold:
 *    - totalNonTransferTxns >= 5  — enough history to establish a pattern
 *    - recentNonTransferTxns30d >= 4  — still actively used in the last month
 *    - p75RecentGapDays > 0 and <= 90  — normally active, not quarterly/annual
 *    - daysSinceLast > p75RecentGapDays * 2  — silence is 2x the usual rhythm
 *    - daysSinceLast >= 7  — minimum absolute threshold (avoid weekend noise)
 *
 * Why P75 and not median: many accounts have multiple transactions on the
 * same day (batch imports), so the median gap is often 0 even after
 * filtering same-day entries. P75 captures the "typical rhythm between
 * distinct active days" more reliably.
 *
 * Why multiplier of 2: balances between sensitivity and noise. In practice,
 * 2x correctly flags accounts like b_tinkoff_rub (P75=6d, silent 17d)
 * while not flagging b_bunq_eur_main (P75=14d, silent 14d).
 */

export type StalenessInput = Readonly<{
  totalNonTransferTxns: number;
  recentNonTransferTxns30d: number;
  p75RecentGapDays: number | null;
  daysSinceLast: number | null;
}>;

const MIN_TXNS = 5;
const MIN_RECENT_TXNS_30D = 4;
const MAX_NORMAL_GAP_DAYS = 90;
const OVERDUE_MULTIPLIER = 2;
const MIN_ABSOLUTE_DAYS = 7;

export function isAccountOverdue(input: StalenessInput): boolean {
  const { totalNonTransferTxns, recentNonTransferTxns30d, p75RecentGapDays, daysSinceLast } = input;

  if (daysSinceLast === null) return false;
  if (p75RecentGapDays === null) return false;
  if (totalNonTransferTxns < MIN_TXNS) return false;
  if (recentNonTransferTxns30d < MIN_RECENT_TXNS_30D) return false;
  if (p75RecentGapDays <= 0) return false;
  if (p75RecentGapDays > MAX_NORMAL_GAP_DAYS) return false;
  if (daysSinceLast < MIN_ABSOLUTE_DAYS) return false;
  if (daysSinceLast <= p75RecentGapDays * OVERDUE_MULTIPLIER) return false;

  return true;
}
