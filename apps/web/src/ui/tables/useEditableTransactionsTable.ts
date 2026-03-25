import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchWithCsrf } from "@/lib/csrf";
import { buildLiveDataUrl } from "@/lib/liveDataFetch";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import type { PageResult } from "./data-table/types";
import { useInfiniteScroll } from "./data-table/useInfiniteScroll";

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

export type DrillDownFilter = Readonly<{
  dateFrom: string;
  dateTo: string;
  direction: string | null;
  category: string | null;
  categories: ReadonlyArray<string> | null;
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
  sentinelRef: ReturnType<typeof useInfiniteScroll<LedgerEntry>>["sentinelRef"];
  addRow: () => void;
  updateEntry: (entryId: string, patch: Partial<LedgerEntry>) => void;
  deleteEntry: (entryId: string) => void;
}>;

export const PAGE_SIZE = 100;
export const CREATE_ERROR_PREFIX = "__create__:";

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
  dateFrom: string,
  dateTo: string,
  selectedAccount: string,
  sortKey: string,
  sortDir: "asc" | "desc",
  refreshToken: string,
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  if (dateFrom.length > 0) params.set("dateFrom", dateFrom);
  if (dateTo.length > 0) params.set("dateTo", dateTo);
  if (selectedAccount.length > 0) params.set("accountId", selectedAccount);
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
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return buildLiveDataUrl("/api/transactions", params, refreshToken);
};

export const buildTransactionsCreateEntryRequest = (
  dateTo: string,
  selectedAccount: string,
): CreateLedgerEntryRequest => ({
  ts: toLocalNoonIso(dateTo),
  accountId: selectedAccount,
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
  kind: filter.direction ?? "spend",
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

const saveTransactionEntry = async (entry: LedgerEntry): Promise<void> => {
  const response = await fetchWithCsrf("/api/transactions/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entryId: entry.entryId,
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
    throw new Error(`Update failed: ${response.status} ${await response.text()}`);
  }
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

  const scroll = useInfiniteScroll<LedgerEntry>(fetchPage, PAGE_SIZE, resetDeps);

  const rows = useMemo<ReadonlyArray<LedgerEntry>>(
    () => mergeLedgerEntries(createdRows, scroll.rows),
    [createdRows, scroll.rows],
  );

  useEffect(() => {
    setCreatedRows([]);
  }, resetDeps);

  const replaceEntry = useCallback((entry: LedgerEntry): void => {
    setCreatedRows((prev) => replaceLedgerEntry(prev, entry));
    scroll.setRows((prev) => replaceLedgerEntry(prev, entry));
  }, [scroll]);

  const updateEntry = useCallback((entryId: string, patch: Partial<LedgerEntry>): void => {
    const entry = rows.find((item) => item.entryId === entryId);
    if (entry === undefined) return;

    onDirty();
    const updated = { ...entry, ...patch };
    replaceEntry(updated);

    saveTransactionEntry(updated).catch((error: unknown) => {
      replaceEntry(entry);
      scroll.setError(getErrorMessage(error));
    });
  }, [onDirty, replaceEntry, rows, scroll]);

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
    sentinelRef: scroll.sentinelRef,
    addRow,
    updateEntry,
    deleteEntry,
  };
};
