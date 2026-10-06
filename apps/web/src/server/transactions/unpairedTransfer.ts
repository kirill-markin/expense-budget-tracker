/**
 * Structural transfer pairing rule, shared by every read that marks a transfer.
 *
 * A movement between two accounts is recorded as two `kind='transfer'` legs of
 * one `event_id`, so a leg whose event holds no other transfer leg is unpaired:
 * one side of the movement is missing and every balance it touches is
 * distorted. The rule compares nothing but the leg count — amounts, currencies,
 * dates and accounts are deliberately ignored, because most real pairs are
 * cross-currency and would never net to zero.
 */

/**
 * Boolean SQL condition for a `ledger_entries` row under `alias`, which must
 * expose `kind`, `workspace_id`, `event_id` and `entry_id`.
 */
export const buildUnpairedTransferCondition = (alias: string): string => `
    ${alias}.kind = 'transfer'
    AND NOT EXISTS (
      SELECT 1
      FROM ledger_entries sibling
      WHERE sibling.workspace_id = ${alias}.workspace_id
        AND sibling.event_id = ${alias}.event_id
        AND sibling.kind = 'transfer'
        AND sibling.entry_id <> ${alias}.entry_id
    )
`;
