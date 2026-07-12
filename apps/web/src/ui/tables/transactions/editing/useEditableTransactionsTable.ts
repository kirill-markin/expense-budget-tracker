import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { fetchWithCsrf } from "@/lib/csrf";
import { buildLiveDataUrl } from "@/lib/liveDataFetch";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import type { PageResult } from "@/ui/tables/shared/data-table/types";
import { useInfiniteScroll } from "@/ui/tables/shared/data-table/useInfiniteScroll";
import {
  acceptTransactionSave,
  createAuthoritativeRowOverride,
  enqueueTransactionSave,
  readLedgerEntryUpdateResponse,
  reconcileDisplayedLedgerEntries,
  rejectTransactionSave,
  startTransactionSave,
  type AuthoritativeRowOverride,
  type TransactionSaveState,
} from "./transactionSaveQueue";

export type CreateLedgerEntryRequest = Readonly<{
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

export type TransactionsTableFilter = Readonly<{
  dateFrom: string;
  dateTo: string;
  accountIds: ReadonlyArray<string>;
  categories: ReadonlyArray<string>;
  kinds: ReadonlyArray<string>;
  currencies: ReadonlyArray<string>;
  counterparties: ReadonlyArray<string>;
}>;

type UseEditableTransactionsTableParams = Readonly<{
  fetchPage: (limit: number, offset: number) => Promise<PageResult<LedgerEntry>>;
  createEntryRequest: () => CreateLedgerEntryRequest;
  resetDeps: ReadonlyArray<unknown>;
  onDirty: () => void;
}>;

type UseEditableTransactionsTableResult = Readonly<{
  rows: ReadonlyArray<LedgerEntry>;
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  pendingEntryIds: ReadonlySet<string>;
  sentinelRef: ReturnType<typeof useInfiniteScroll<LedgerEntry>>["sentinelRef"];
  addRow: () => void;
  updateEntry: (entryId: string, patch: EditableLedgerEntryPatch) => void;
  deleteEntry: (entryId: string) => void;
}>;

type EditableLedgerEntryPatch = Partial<Pick<
  LedgerEntry,
  "ts" | "accountId" | "amount" | "currency" | "kind" | "category" | "counterparty" | "note"
>>;

export const PAGE_SIZE = 100;
export const CREATE_ERROR_PREFIX = "__create__:";
export const UPDATE_ERROR_PREFIX = "__update__:";

export const toLocalNoonIso = (dateValue: string): string => {
  return new Date(`${dateValue}T12:00`).toISOString();
};

export const mergeLedgerEntries = (
  createdRows: ReadonlyArray<LedgerEntry>,
  fetchedRows: ReadonlyArray<LedgerEntry>,
): ReadonlyArray<LedgerEntry> => {
  const seen = new Set<string>();
  const merged: Array<LedgerEntry> = [];

  for (const row of createdRows) {
    if (seen.has(row.entryId)) continue;
    seen.add(row.entryId);
    merged.push(row);
  }
  for (const row of fetchedRows) {
    if (seen.has(row.entryId)) continue;
    seen.add(row.entryId);
    merged.push(row);
  }

  return merged;
};

export const replaceLedgerEntry = (
  rows: ReadonlyArray<LedgerEntry>,
  entry: LedgerEntry,
): ReadonlyArray<LedgerEntry> => {
  return rows.map((item) => (item.entryId === entry.entryId ? entry : item));
};

export const removeLedgerEntry = (
  rows: ReadonlyArray<LedgerEntry>,
  entryId: string,
): ReadonlyArray<LedgerEntry> => {
  return rows.filter((item) => item.entryId !== entryId);
};

export const prependLedgerEntry = (
  rows: ReadonlyArray<LedgerEntry>,
  entry: LedgerEntry,
): ReadonlyArray<LedgerEntry> => {
  return [entry, ...rows.filter((item) => item.entryId !== entry.entryId)];
};

export const buildTransactionsPageUrl = (
  filter: TransactionsTableFilter,
  sortKey: string,
  sortDir: "asc" | "desc",
  refreshToken: string,
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  if (filter.dateFrom.length > 0) params.set("dateFrom", filter.dateFrom);
  if (filter.dateTo.length > 0) params.set("dateTo", filter.dateTo);
  for (const accountId of filter.accountIds) {
    params.append("accountIds", accountId);
  }
  for (const category of filter.categories) {
    params.append("categories", category);
  }
  for (const kind of filter.kinds) {
    params.append("kinds", kind);
  }
  for (const currency of filter.currencies) {
    params.append("currencies", currency);
  }
  for (const counterparty of filter.counterparties) {
    params.append("counterparties", counterparty);
  }
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return buildLiveDataUrl("/api/transactions", params, refreshToken);
};

export const buildDrillDownPageUrl = (
  filter: DrillDownFilter,
  sortKey: string,
  sortDir: "asc" | "desc",
  refreshToken: string,
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  params.set("dateFrom", filter.dateFrom);
  params.set("dateTo", filter.dateTo);
  if (filter.direction !== null) {
    params.set("kind", filter.direction);
  }
  if (filter.category !== null) {
    params.set("category", filter.category);
  }
  if (filter.categories !== null) {
    for (const category of filter.categories) {
      params.append("categories", category);
    }
  }
  if (filter.businessPersonalTransfers) {
    params.set("businessPersonalTransfers", "true");
  }
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return buildLiveDataUrl("/api/transactions", params, refreshToken);
};

export const buildTransactionsCreateEntryRequest = (
  dateTo: string,
  selectedAccountIds: ReadonlyArray<string>,
): CreateLedgerEntryRequest => ({
  ts: toLocalNoonIso(dateTo),
  accountId: selectedAccountIds.length === 1 ? selectedAccountIds[0] : "",
  amount: 0,
  currency: "",
  kind: "spend",
  category: null,
  counterparty: null,
  note: null,
});

export const buildDrillDownCreateEntryRequest = (
  filter: DrillDownFilter,
): CreateLedgerEntryRequest => ({
  ts: toLocalNoonIso(filter.dateTo),
  accountId: "",
  amount: 0,
  currency: "",
  kind: filter.businessPersonalTransfers ? "transfer" : (filter.direction ?? "spend"),
  category: filter.category === null ? null : (filter.category === "" ? null : filter.category),
  counterparty: null,
  note: null,
});

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const deleteTransactionEntry = async (entryId: string): Promise<void> => {
  const response = await fetchWithCsrf("/api/transactions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
  if (!response.ok) {
    throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
  }
};

const saveTransactionEntry = async (entry: LedgerEntry): Promise<LedgerEntry> => {
  const response = await fetchWithCsrf("/api/transactions/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entryId: entry.entryId,
      eventId: entry.eventId,
      category: entry.category,
      note: entry.note,
      counterparty: entry.counterparty,
      kind: entry.kind,
      ts: entry.ts,
      accountId: entry.accountId,
      amount: entry.amount,
      currency: entry.currency,
    }),
  });
  if (!response.ok) {
    throw new Error(`Update failed for entry ${entry.entryId}: ${response.status} ${await response.text()}`);
  }
  return readLedgerEntryUpdateResponse(response, entry);
};

const createTransactionEntry = async (entry: CreateLedgerEntryRequest): Promise<LedgerEntry> => {
  const response = await fetchWithCsrf("/api/transactions/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!response.ok) {
    throw new Error(`Create failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as LedgerEntry;
};

export const useEditableTransactionsTable = (
  params: UseEditableTransactionsTableParams,
): UseEditableTransactionsTableResult => {
  const { fetchPage, createEntryRequest, resetDeps, onDirty } = params;
  const [createdRows, setCreatedRows] = useState<ReadonlyArray<LedgerEntry>>([]);
  const [pendingEntryIds, setPendingEntryIds] = useState<ReadonlySet<string>>(new Set<string>());
  const saveStatesRef = useRef<Map<string, TransactionSaveState>>(new Map<string, TransactionSaveState>());
  const authoritativeOverridesRef = useRef<Map<string, AuthoritativeRowOverride>>(new Map<string, AuthoritativeRowOverride>());
  const fetchedRowVersionsRef = useRef<WeakMap<LedgerEntry, number>>(new WeakMap<LedgerEntry, number>());
  const fetchVersionRef = useRef<number>(0);
  const rowsRef = useRef<ReadonlyArray<LedgerEntry>>([]);

  const fetchVersionedPage = useCallback(async (
    limit: number,
    offset: number,
  ): Promise<PageResult<LedgerEntry>> => {
    const fetchVersion = ++fetchVersionRef.current;
    const page = await fetchPage(limit, offset);
    const items = page.items.map((row): LedgerEntry => ({ ...row }));
    for (const row of items) {
      fetchedRowVersionsRef.current.set(row, fetchVersion);
    }
    return { items, total: page.total };
  }, [fetchPage]);

  const scroll = useInfiniteScroll<LedgerEntry>(fetchVersionedPage, PAGE_SIZE, resetDeps);

  const displayReconciliation = useMemo(
    () => reconcileDisplayedLedgerEntries(
      mergeLedgerEntries(createdRows, scroll.rows),
      (row: LedgerEntry): number | null => fetchedRowVersionsRef.current.get(row) ?? null,
      saveStatesRef.current,
      authoritativeOverridesRef.current,
    ),
    [createdRows, pendingEntryIds, scroll.rows],
  );
  const rows = displayReconciliation.rows;

  useEffect(() => {
    if (displayReconciliation.overrideRetirements.length === 0) return;

    const nextOverrides = new Map(authoritativeOverridesRef.current);
    let changed = false;
    for (const retirement of displayReconciliation.overrideRetirements) {
      if (nextOverrides.get(retirement.entryId) !== retirement.override) continue;
      nextOverrides.delete(retirement.entryId);
      changed = true;
    }
    if (changed) {
      authoritativeOverridesRef.current = nextOverrides;
    }
  }, [displayReconciliation.overrideRetirements]);

  useLayoutEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    setCreatedRows([]);
  }, resetDeps);

  const replaceEntry = useCallback((entry: LedgerEntry): void => {
    rowsRef.current = replaceLedgerEntry(rowsRef.current, entry);
    setCreatedRows((prev) => replaceLedgerEntry(prev, entry));
    scroll.setRows((prev) => replaceLedgerEntry(prev, entry));
  }, [scroll]);

  const markEntryPending = useCallback((entryId: string): void => {
    setPendingEntryIds((current) => new Set([...current, entryId]));
  }, []);

  const clearEntryPending = useCallback((entryId: string): void => {
    setPendingEntryIds((current) => {
      const next = new Set(current);
      next.delete(entryId);
      return next;
    });
  }, []);

  const protectAuthoritativeEntry = useCallback((entry: LedgerEntry): void => {
    const nextOverrides = new Map(authoritativeOverridesRef.current);
    nextOverrides.set(
      entry.entryId,
      createAuthoritativeRowOverride(entry, fetchVersionRef.current),
    );
    authoritativeOverridesRef.current = nextOverrides;
  }, []);

  const processEntryQueue = useCallback(async (entryId: string): Promise<void> => {
    while (true) {
      const state = saveStatesRef.current.get(entryId);
      if (state === undefined) return;

      let authoritative: LedgerEntry;
      try {
        authoritative = await saveTransactionEntry(state.active);
      } catch (error: unknown) {
        const failedState = saveStatesRef.current.get(entryId);
        if (failedState === undefined) return;

        const rollbackEntry = rejectTransactionSave(failedState);
        protectAuthoritativeEntry(rollbackEntry);
        saveStatesRef.current.delete(entryId);
        replaceEntry(rollbackEntry);
        clearEntryPending(entryId);
        scroll.setError(`${UPDATE_ERROR_PREFIX}${getErrorMessage(error)}`);
        return;
      }

      const latestState = saveStatesRef.current.get(entryId);
      if (latestState === undefined) return;
      const accepted = acceptTransactionSave(latestState, authoritative);
      if (accepted.status === "complete") {
        protectAuthoritativeEntry(accepted.row);
        saveStatesRef.current.delete(entryId);
        replaceEntry(accepted.row);
        clearEntryPending(entryId);
        return;
      }

      saveStatesRef.current.set(entryId, accepted.state);
    }
  }, [clearEntryPending, protectAuthoritativeEntry, replaceEntry, scroll]);

  const updateEntry = useCallback((entryId: string, patch: EditableLedgerEntryPatch): void => {
    const entry = rowsRef.current.find((item) => item.entryId === entryId);
    if (entry === undefined) return;

    onDirty();
    const updated = { ...entry, ...patch };
    replaceEntry(updated);
    scroll.setError(null);

    const existingState = saveStatesRef.current.get(entryId);
    if (existingState === undefined) {
      saveStatesRef.current.set(entryId, startTransactionSave(entry, updated));
      markEntryPending(entryId);
      void processEntryQueue(entryId);
      return;
    }

    saveStatesRef.current.set(entryId, enqueueTransactionSave(existingState, updated));
  }, [markEntryPending, onDirty, processEntryQueue, replaceEntry, scroll]);

  const addRow = useCallback((): void => {
    scroll.setError(null);

    createTransactionEntry(createEntryRequest())
      .then((entry) => {
        onDirty();
        setCreatedRows((prev) => prependLedgerEntry(prev, entry));
        scroll.setTotal((prev) => prev + 1);
      })
      .catch((error: unknown) => {
        scroll.setError(`${CREATE_ERROR_PREFIX}${getErrorMessage(error)}`);
      });
  }, [createEntryRequest, onDirty, scroll]);

  const deleteEntry = useCallback((entryId: string): void => {
    const entry = rows.find((item) => item.entryId === entryId);
    if (entry === undefined) return;

    onDirty();

    const prevCreatedRows = createdRows;
    const prevFetchedRows = scroll.rows;
    const prevTotal = scroll.total;

    setCreatedRows((prev) => removeLedgerEntry(prev, entryId));
    scroll.setRows((prev) => removeLedgerEntry(prev, entryId));
    scroll.setTotal((prev) => prev - 1);

    deleteTransactionEntry(entryId).catch((error: unknown) => {
      setCreatedRows(prevCreatedRows);
      scroll.setRows(prevFetchedRows);
      scroll.setTotal(prevTotal);
      scroll.setError(getErrorMessage(error));
    });
  }, [createdRows, onDirty, rows, scroll]);

  return {
    rows,
    total: scroll.total,
    loading: scroll.loading,
    loadingMore: scroll.loadingMore,
    error: scroll.error,
    pendingEntryIds,
    sentinelRef: scroll.sentinelRef,
    addRow,
    updateEntry,
    deleteEntry,
  };
};
