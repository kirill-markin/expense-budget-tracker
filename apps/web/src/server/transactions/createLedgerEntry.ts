/**
 * Create a ledger entry and return the inserted row with report-currency amount.
 *
 * Create responses use the same exact-date FX read model as the dashboards:
 * every conversion comes from fx_rates_daily instead of ad hoc range lookups.
 */
import { queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";
import { mapLedgerEntryRow, type LedgerEntry, type LedgerEntryRow } from "@/server/transactions/getTransactions";

type CreateLedgerEntryParams = Readonly<{
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

export type { CreateLedgerEntryParams };

export const createLedgerEntry = async (
  userId: string,
  workspaceId: string,
  params: CreateLedgerEntryParams,
): Promise<LedgerEntry> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  const result = await queryAs(
    userId,
    workspaceId,
    `
      WITH inserted AS (
        INSERT INTO ledger_entries (
          event_id,
          ts,
          account_id,
          amount,
          currency,
          kind,
          category,
          counterparty,
          note,
          workspace_id
        )
        VALUES (
          gen_random_uuid()::text,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )
        RETURNING entry_id, event_id, ts, account_id, amount, currency, kind, category, counterparty, note
      )
      SELECT
        i.entry_id,
        i.event_id,
        i.ts,
        i.account_id,
        i.amount::double precision AS amount,
        CASE
          WHEN i.currency = $1 THEN i.amount::double precision
          WHEN r.rate IS NOT NULL THEN i.amount::double precision * r.rate::double precision
          ELSE NULL
        END AS amount_report,
        i.currency,
        i.kind,
        i.category,
        i.counterparty,
        i.note
      FROM inserted i
      LEFT JOIN fx_rates_daily r
        ON r.quote_currency = $1
        AND r.base_currency = i.currency
        AND r.calendar_date = i.ts::date
    `,
    [
      reportCurrency,
      params.ts,
      params.accountId,
      params.amount,
      params.currency,
      params.kind,
      params.category,
      params.counterparty,
      params.note,
      workspaceId,
    ],
  );

  const row = result.rows[0] as LedgerEntryRow | undefined;
  if (row === undefined) {
    throw new Error("Failed to create ledger entry: insert returned no row");
  }

  return mapLedgerEntryRow(row);
};
