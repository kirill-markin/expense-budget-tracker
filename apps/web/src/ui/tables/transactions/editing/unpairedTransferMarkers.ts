/**
 * Client-side replay of the structural transfer pairing rule in
 * `apps/web/src/server/transactions/unpairedTransfer.ts`, so the siblings of a
 * mutated leg stop showing a stale marker before the next fetch.
 *
 * It sees only the loaded rows: an event with legs outside the loaded page
 * keeps the marker the server computed over the whole ledger until that page
 * arrives. The limitation runs in both directions: for an event with three or
 * more legs it can also mark a loaded survivor unpaired while an off-page leg
 * still pairs it. The app cannot build such an event, since the create path
 * mints one `event_id` per entry and updates never rewrite it, and the next
 * fetch replaces the marker with the server's.
 */

import type { LedgerEntry } from "@/server/transactions/getTransactions";

/**
 * Updated copies of the loaded transfer legs of `eventId`, other than
 * `mutatedEntryId`, whose marker the remaining leg count flips.
 *
 * `rows` must already reflect the mutation: after a delete it must no longer
 * contain `mutatedEntryId`, and after an update it must contain that row with
 * its new `kind`. The leg count below includes the mutated row, which is
 * dropped only from the returned set, so a caller that leaves a deleted leg in
 * `rows` counts two legs and stops marking the survivor.
 */
export const computeUnpairedTransferRemarks = (
  rows: ReadonlyArray<LedgerEntry>,
  eventId: string,
  mutatedEntryId: string,
): ReadonlyArray<LedgerEntry> => {
  const transferLegs = rows.filter(
    (row) => row.eventId === eventId && row.kind === "transfer",
  );
  const isUnpairedTransfer = transferLegs.length === 1;

  return transferLegs
    .filter((row) => row.entryId !== mutatedEntryId)
    .filter((row) => row.isUnpairedTransfer !== isUnpairedTransfer)
    .map((row): LedgerEntry => ({ ...row, isUnpairedTransfer }));
};
