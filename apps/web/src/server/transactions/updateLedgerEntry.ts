/**
 * Inline editing of ledger entry metadata.
 *
 * Updates only the mutable fields (category, note) of an existing entry.
 * Amount, currency, account, and timestamp are immutable after creation.
 * RLS ensures the update only affects entries owned by the given user.
 */
import { queryAs } from "@/server/db";

type UpdateLedgerEntryParams = Readonly<{
  entryId: string;
  category: string | null;
  note: string | null;
}>;

export type { UpdateLedgerEntryParams };

export const updateLedgerEntry = async (userId: string, params: UpdateLedgerEntryParams): Promise<void> => {
  await queryAs(
    userId,
    "UPDATE ledger_entries SET category = $1, note = $2 WHERE entry_id = $3",
    [params.category, params.note, params.entryId],
  );
};
