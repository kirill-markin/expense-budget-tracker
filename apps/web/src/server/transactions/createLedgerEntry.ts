/**
 * Create a ledger entry and return the inserted row with report-currency amount.
 */
import { queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";

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

type LedgerEntryRow = Readonly<{
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

export const createLedgerEntry = async (
  userId: string,
  workspaceId: string,
  params: CreateLedgerEntryParams,
): Promise<Readonly<{
  entryId: string;
  eventId: string;
  ts: string;
  accountId: string;
  amount: number;
  amountUsd: number | null;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>> => {
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
      LEFT JOIN LATERAL (
        SELECT rate FROM exchange_rates
        WHERE quote_currency = $1
          AND base_currency = i.currency
          AND rate_date <= i.ts::date
        ORDER BY rate_date DESC
        LIMIT 1
      ) r ON true
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

  return {
    entryId: row.entry_id,
    eventId: row.event_id,
    ts: new Date(row.ts).toISOString(),
    accountId: row.account_id,
    amount: Number(row.amount),
    amountUsd: row.amount_report !== null ? Number(row.amount_report) : null,
    currency: row.currency,
    kind: row.kind,
    category: row.category,
    counterparty: row.counterparty,
    note: row.note,
  };
};
