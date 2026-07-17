import { z } from "zod";

import { computeAccountStatus } from "@/server/balances/accountStatus";
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";

export type AccountSuggestion = Readonly<{
  accountId: string;
  currency: string;
}>;

const accountSuggestionDbRowSchema = z.object({
  account_id: z.string().max(200),
  currency: z.string().max(10),
  balance: z.number().finite(),
  last_non_transfer_ms: z.number().finite().nullable(),
  latest_operation_ms: z.number().finite(),
});

type AccountSuggestionDbRow = z.infer<typeof accountSuggestionDbRowSchema>;

export const ACCOUNT_SUGGESTIONS_QUERY = `
  SELECT
    a.account_id,
    a.currency,
    COALESCE(SUM(le.amount)::double precision, 0::double precision) AS balance,
    (
      EXTRACT(EPOCH FROM MAX(CASE WHEN le.kind != 'transfer' THEN le.ts END))
      * 1000
    )::double precision AS last_non_transfer_ms,
    (EXTRACT(EPOCH FROM MAX(le.ts)) * 1000)::double precision AS latest_operation_ms
  FROM accounts a
  LEFT JOIN ledger_entries le
    ON le.workspace_id = current_setting('app.workspace_id', true)
   AND le.account_id = a.account_id
  GROUP BY a.account_id, a.currency
  ORDER BY MAX(le.ts) DESC, a.account_id
`;

const parseAccountSuggestionDbRow = (
  row: unknown,
  rowIndex: number,
): AccountSuggestionDbRow => {
  const result = accountSuggestionDbRowSchema.safeParse(row);
  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid account suggestion database row at index ${rowIndex}: ${details}`);
};

export const getAccountSuggestionsWithQuery = async (
  queryFn: QueryFn,
  currentTimeMs: number,
): Promise<ReadonlyArray<AccountSuggestion>> => {
  const result = await queryFn(ACCOUNT_SUGGESTIONS_QUERY, []);
  const suggestions: Array<AccountSuggestion> = [];

  for (const [rowIndex, untrustedRow] of result.rows.entries()) {
    const row = parseAccountSuggestionDbRow(untrustedRow, rowIndex);
    if (computeAccountStatus(row.balance, row.last_non_transfer_ms, currentTimeMs) === "active") {
      suggestions.push({
        accountId: row.account_id,
        currency: row.currency,
      });
    }
  }

  return suggestions;
};

export const getAccountSuggestions = async (
  userId: string,
  workspaceId: string,
): Promise<ReadonlyArray<AccountSuggestion>> =>
  withUserContext(
    userId,
    workspaceId,
    async (queryFn): Promise<ReadonlyArray<AccountSuggestion>> =>
      getAccountSuggestionsWithQuery(queryFn, Date.now()),
  );
