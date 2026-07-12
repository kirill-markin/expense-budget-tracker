import { getCellVisibility } from "@/lib/dataMask";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

export type TransactionClipboardPayload = Readonly<{
  entry_id: string;
  event_id: string;
  ts: string;
  account_id: string;
  amount: number;
  amount_report: number | null;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

export const toTransactionClipboardPayload = (
  entry: LedgerEntry,
): TransactionClipboardPayload => ({
  entry_id: entry.entryId,
  event_id: entry.eventId,
  ts: entry.ts,
  account_id: entry.accountId,
  amount: entry.amount,
  amount_report: entry.amountReport,
  currency: entry.currency,
  kind: entry.kind,
  category: entry.category,
  counterparty: entry.counterparty,
  note: entry.note,
});

export const serializeTransactionClipboard = (entry: LedgerEntry): string =>
  JSON.stringify(toTransactionClipboardPayload(entry), null, 2);

export const isTransactionCopyAvailable = (
  entry: LedgerEntry,
  effectiveAllowlist: ReadonlySet<string> | null,
  pendingEntryIds: ReadonlySet<string>,
): boolean =>
  getCellVisibility(effectiveAllowlist, entry.category).showData
  && !pendingEntryIds.has(entry.entryId);
