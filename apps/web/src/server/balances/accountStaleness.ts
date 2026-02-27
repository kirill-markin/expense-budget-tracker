/**
 * Smart staleness detection for financial accounts.
 *
 * Instead of a fixed "N days since last transaction" threshold, this module
 * detects when an account's silence is unusual *for that specific account*
 * based on its recent transaction rhythm.
 *
 * Algorithm — "Overdue MAX, last 20":
 *
 * 1. Compute the maximum of the last 20 non-zero inter-transaction gaps
 *    for each account (excluding transfers and same-day entries).
 *    Using "last 20" instead of full history makes the algorithm adapt
 *    when an account changes its usage pattern (e.g. from daily to monthly).
 *
 * 2. Flag the account as overdue when ALL conditions hold:
 *    - totalNonTransferTxns >= 5  — enough history to establish a pattern
 *    - recentNonTransferTxns30d >= 4  — still actively used in the last month
 *    - maxRecentGapDays > 0 and <= 90  — normally active, not quarterly/annual
 *    - daysSinceLast > maxRecentGapDays * 1.5  — silence is 1.5x the longest recent gap
 *    - daysSinceLast >= 2  — minimum absolute threshold
 *
 * Why MAX instead of P75: P75 only captures 75% of natural variation, so
 * accounts with occasional long gaps (e.g. 14-day gaps) get false positives
 * when P75 is much lower (~7d). MAX tolerates the full range of observed gaps.
 *
 * Why multiplier of 1.5: MAX is already more tolerant than P75, so a lower
 * multiplier still avoids noise while catching genuine staleness faster.
 */

export type StalenessInput = Readonly<{
  totalNonTransferTxns: number;
  recentNonTransferTxns30d: number;
  maxRecentGapDays: number | null;
  daysSinceLast: number | null;
}>;

const MIN_TXNS = 5;
const MIN_RECENT_TXNS_30D = 4;
const MAX_NORMAL_GAP_DAYS = 90;
const OVERDUE_MULTIPLIER = 1.5;
const MIN_ABSOLUTE_DAYS = 2;

export function isAccountOverdue(input: StalenessInput): boolean {
  const { totalNonTransferTxns, recentNonTransferTxns30d, maxRecentGapDays, daysSinceLast } = input;

  if (daysSinceLast === null) return false;
  if (maxRecentGapDays === null) return false;
  if (totalNonTransferTxns < MIN_TXNS) return false;
  if (recentNonTransferTxns30d < MIN_RECENT_TXNS_30D) return false;
  if (maxRecentGapDays <= 0) return false;
  if (maxRecentGapDays > MAX_NORMAL_GAP_DAYS) return false;
  if (daysSinceLast < MIN_ABSOLUTE_DAYS) return false;
  if (daysSinceLast <= maxRecentGapDays * OVERDUE_MULTIPLIER) return false;

  return true;
}
