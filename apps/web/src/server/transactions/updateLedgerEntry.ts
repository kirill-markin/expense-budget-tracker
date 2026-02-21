/**
 * Inline editing of ledger entry metadata.
 *
 * Updates only the mutable fields (category, note) of an existing entry.
 * Amount, currency, account, and timestamp are immutable after creation.
 */
import { query } from "@/server/db";

type UpdateLedgerEntryParams = Readonly<{
  entryId: string;
  category: string | null;
  note: string | null;
}>;

export type { UpdateLedgerEntryParams };

export const updateLedgerEntry = async (params: UpdateLedgerEntryParams): Promise<void> => {
  await query(
    "UPDATE ledger_entries SET category = $1, note = $2 WHERE entry_id = $3",
    [params.category, params.note, params.entryId],
  );
};
