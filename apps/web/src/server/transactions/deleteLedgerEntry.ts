/**
 * Delete a ledger entry by its ID.
 *
 * RLS ensures the delete only affects entries owned by the given user.
 */
import { queryAs } from "@/server/db";

export const deleteLedgerEntry = async (userId: string, workspaceId: string, entryId: string): Promise<void> => {
  await queryAs(
    userId,
    workspaceId,
    "DELETE FROM ledger_entries WHERE entry_id = $1",
    [entryId],
  );
};
