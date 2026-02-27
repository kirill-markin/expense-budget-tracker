/**
 * Inline editing of a ledger entry.
 *
 * Updates all user-editable fields of an existing entry.
 * RLS ensures the update only affects entries owned by the given user.
 */
import { queryAs } from "@/server/db";

type UpdateLedgerEntryParams = Readonly<{
  entryId: string;
  category: string | null;
  note: string | null;
  counterparty: string | null;
  kind: string;
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
}>;

export type { UpdateLedgerEntryParams };

export const updateLedgerEntry = async (userId: string, workspaceId: string, params: UpdateLedgerEntryParams): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    "UPDATE ledger_entries SET category = $1, note = $2, counterparty = $3, kind = $4, ts = $5, account_id = $6, amount = $7, currency = $8 WHERE entry_id = $9",
    [params.category, params.note, params.counterparty, params.kind, params.ts, params.accountId, params.amount, params.currency, params.entryId],
  );
};
