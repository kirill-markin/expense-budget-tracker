/**
 * Inline editing of a ledger entry.
 *
 * Updates all user-editable fields of an existing entry.
 * RLS ensures the update only affects entries owned by the given user.
 */
import { queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";
import { mapLedgerEntryRow, type LedgerEntry, type LedgerEntryRow } from "@/server/transactions/getTransactions";

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

export const updateLedgerEntry = async (
  userId: string,
  workspaceId: string,
  params: UpdateLedgerEntryParams,
): Promise<LedgerEntry> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  const result = await queryAs(
    userId,
    workspaceId,
    `
      WITH updated AS (
        UPDATE ledger_entries
        SET
          category = $2,
          note = $3,
          counterparty = $4,
          kind = $5,
          ts = $6,
          account_id = $7,
          amount = $8,
          currency = $9
        WHERE entry_id = $10
        RETURNING entry_id, event_id, ts, account_id, amount, currency, kind, category, counterparty, note
      )
      SELECT
        u.entry_id,
        u.event_id,
        u.ts,
        u.account_id,
        u.amount::double precision AS amount,
        CASE
          WHEN u.currency = $1 THEN u.amount::double precision
          WHEN r.rate IS NOT NULL THEN u.amount::double precision * r.rate::double precision
          ELSE NULL
        END AS amount_report,
        u.currency,
        u.kind,
        u.category,
        u.counterparty,
        u.note
      FROM updated u
      LEFT JOIN fx_rates_daily r
        ON r.quote_currency = $1
        AND r.base_currency = u.currency
        AND r.calendar_date = u.ts::date
    `,
    [
      reportCurrency,
      params.category,
      params.note,
      params.counterparty,
      params.kind,
      params.ts,
      params.accountId,
      params.amount,
      params.currency,
      params.entryId,
    ],
  );

  const row = result.rows[0] as LedgerEntryRow | undefined;
  if (row === undefined) {
    throw new Error(
      `No ledger entry was updated for entryId "${params.entryId}": the entry does not exist in workspace "${workspaceId}" or is not accessible to the current user`,
    );
  }

  return mapLedgerEntryRow(row);
};
