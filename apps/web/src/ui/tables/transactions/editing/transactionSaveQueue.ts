import { z } from "zod";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

const ledgerEntrySchema = z.object({
  entryId: z.string().min(1),
  eventId: z.string().min(1),
  ts: z.string().datetime(),
  accountId: z.string(),
  amount: z.number().finite(),
  amountReport: z.number().finite().nullable(),
  currency: z.string(),
  kind: z.string(),
  category: z.string().nullable(),
  counterparty: z.string().nullable(),
  note: z.string().nullable(),
});

export type TransactionSaveState = Readonly<{
  authoritative: LedgerEntry;
  optimistic: LedgerEntry;
  active: LedgerEntry;
  queued: ReadonlyArray<LedgerEntry>;
}>;

export type AuthoritativeRowOverride = Readonly<{
  row: LedgerEntry;
  throughFetchVersion: number;
}>;

export type ReconciledLedgerEntries = Readonly<{
  rows: ReadonlyArray<LedgerEntry>;
  overrideRetirements: ReadonlyArray<AuthoritativeOverrideRetirement>;
}>;

export type AuthoritativeOverrideRetirement = Readonly<{
  entryId: string;
  override: AuthoritativeRowOverride;
}>;

export type AcceptedTransactionSave =
  | Readonly<{ status: "complete"; row: LedgerEntry }>
  | Readonly<{ status: "continue"; row: LedgerEntry; state: TransactionSaveState }>;

const formatValidationIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue): string => `${issue.path.join(".") || "response"}: ${issue.message}`)
    .join("; ");

export const parseLedgerEntryResponse = (
  input: unknown,
  expectedEntryId: string,
  expectedEventId: string,
): LedgerEntry => {
  const result = ledgerEntrySchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Update failed for entry ${expectedEntryId}: invalid ledger entry response (${formatValidationIssues(result.error)})`,
    );
  }

  if (result.data.entryId !== expectedEntryId) {
    throw new Error(
      `Update failed for entry ${expectedEntryId}: response entryId was ${result.data.entryId}`,
    );
  }
  if (result.data.eventId !== expectedEventId) {
    throw new Error(
      `Update failed for entry ${expectedEntryId}: response eventId was ${result.data.eventId}, expected ${expectedEventId}`,
    );
  }

  return result.data;
};

export const readLedgerEntryUpdateResponse = async (
  response: Response,
  entry: LedgerEntry,
): Promise<LedgerEntry> => {
  const responseBody = await response.text();
  let input: unknown;
  try {
    input = JSON.parse(responseBody);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Update failed for entry ${entry.entryId}: response status ${response.status} was not valid JSON (${reason}); body: ${responseBody}`,
    );
  }

  try {
    return parseLedgerEntryResponse(input, entry.entryId, entry.eventId);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}; response status: ${response.status}; body: ${responseBody}`);
  }
};

export const startTransactionSave = (
  authoritative: LedgerEntry,
  optimistic: LedgerEntry,
): TransactionSaveState => ({
  authoritative,
  optimistic,
  active: optimistic,
  queued: [],
});

export const enqueueTransactionSave = (
  state: TransactionSaveState,
  optimistic: LedgerEntry,
): TransactionSaveState => ({
  ...state,
  optimistic,
  queued: [...state.queued, optimistic],
});

export const acceptTransactionSave = (
  state: TransactionSaveState,
  authoritative: LedgerEntry,
): AcceptedTransactionSave => {
  const nextActive = state.queued[0];
  if (nextActive === undefined) {
    return { status: "complete", row: authoritative };
  }

  return {
    status: "continue",
    row: state.optimistic,
    state: {
      authoritative,
      optimistic: state.optimistic,
      active: nextActive,
      queued: state.queued.slice(1),
    },
  };
};

export const rejectTransactionSave = (state: TransactionSaveState): LedgerEntry =>
  state.authoritative;

export const createAuthoritativeRowOverride = (
  row: LedgerEntry,
  throughFetchVersion: number,
): AuthoritativeRowOverride => ({ row, throughFetchVersion });

export const reconcileDisplayedLedgerEntries = (
  displayedRows: ReadonlyArray<LedgerEntry>,
  getFetchVersion: (row: LedgerEntry) => number | null,
  saveStates: ReadonlyMap<string, TransactionSaveState>,
  authoritativeOverrides: ReadonlyMap<string, AuthoritativeRowOverride>,
): ReconciledLedgerEntries => {
  const overrideRetirements: Array<AuthoritativeOverrideRetirement> = [];
  const rows = displayedRows.map((row): LedgerEntry => {
    const saveState = saveStates.get(row.entryId);
    if (saveState !== undefined) {
      return saveState.optimistic;
    }

    const authoritativeOverride = authoritativeOverrides.get(row.entryId);
    if (authoritativeOverride === undefined) {
      return row;
    }
    const fetchVersion = getFetchVersion(row);
    if (fetchVersion === null || fetchVersion <= authoritativeOverride.throughFetchVersion) {
      return authoritativeOverride.row;
    }

    overrideRetirements.push({ entryId: row.entryId, override: authoritativeOverride });
    return row;
  });

  return { rows, overrideRetirements };
};
