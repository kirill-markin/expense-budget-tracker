"use client";

import { type ReactElement } from "react";
import { useState } from "react";

import type { AccountOption, FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFilteredMode } from "@/ui/FilteredModeProvider";

import { DataTable } from "./data-table/DataTable";
import type { ColumnDef, PageResult } from "./data-table/types";
import { useInfiniteScroll } from "./data-table/useInfiniteScroll";
import { useTableSort } from "./data-table/useTableSort";
import { EditableAmount } from "./EditableAmount";
import { EditableCategory } from "./EditableCategory";
import { EditableDateTime } from "./EditableDateTime";
import { EditableKind } from "./EditableKind";
import { EditableText } from "./EditableText";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountOption>;
  categories: ReadonlyArray<string>;
  hints: FieldHints;
}>;

type SortKey = "ts" | "accountId" | "amount" | "currency" | "kind" | "category" | "counterparty";

const PAGE_SIZE = 100;

const SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = { amount: "desc" };

const toDateInputValue = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const buildUrl = (
  dateFrom: string,
  dateTo: string,
  selectedAccount: string,
  sortKey: SortKey,
  sortDir: "asc" | "desc",
  limit: number,
  offset: number,
): string => {
  const params = new URLSearchParams();
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (selectedAccount) params.set("accountId", selectedAccount);
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/transactions?${params.toString()}`;
};

const saveEntry = async (entry: LedgerEntry): Promise<void> => {
  const response = await fetch("/api/transactions/update", {
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

export const TransactionsRawTable = (props: Props): ReactElement => {
  const { accounts, categories, hints } = props;
  const { effectiveAllowlist } = useFilteredMode();

  const getMaskClass = (category: string | null): string => {
    if (effectiveAllowlist === null) return "";
    if (category !== null && effectiveAllowlist.has(category)) return "";
    return " data-masked";
  };

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [dateFrom, setDateFrom] = useState<string>(toDateInputValue(ninetyDaysAgo));
  const [dateTo, setDateTo] = useState<string>(toDateInputValue(now));
  const [selectedAccount, setSelectedAccount] = useState<string>("");

  const { sort, onSort } = useTableSort("single", "ts", "desc", SORT_DEFAULTS);

  const fetchPage = async (limit: number, offset: number): Promise<PageResult<LedgerEntry>> => {
    const url = buildUrl(dateFrom, dateTo, selectedAccount, sort[0].key as SortKey, sort[0].dir, limit, offset);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();
    return { items: page.entries, total: page.total };
  };

  const scroll = useInfiniteScroll<LedgerEntry>(
    fetchPage,
    PAGE_SIZE,
    [dateFrom, dateTo, selectedAccount, sort[0].key, sort[0].dir],
  );

  const optimisticUpdate = (
    entryId: string,
    patch: Partial<LedgerEntry>,
    rollback: Partial<LedgerEntry>,
  ): void => {
    const entry = scroll.rows.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    const updated = { ...entry, ...patch };
    scroll.setRows((prev) =>
      prev.map((e) => (e.entryId === entryId ? updated : e)),
    );

    saveEntry(updated).catch((err: unknown) => {
      scroll.setRows((prev) =>
        prev.map((e) => (e.entryId === entryId ? { ...e, ...rollback } : e)),
      );
      scroll.setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleCategoryChange = (entryId: string, newCategory: string | null, oldCategory: string | null): void => {
    optimisticUpdate(entryId, { category: newCategory }, { category: oldCategory });
  };

  const handleNoteCommit = (entryId: string, newNote: string | null, oldNote: string | null): void => {
    optimisticUpdate(entryId, { note: newNote }, { note: oldNote });
  };

  const handleCounterpartyCommit = (entryId: string, newCounterparty: string | null, oldCounterparty: string | null): void => {
    optimisticUpdate(entryId, { counterparty: newCounterparty }, { counterparty: oldCounterparty });
  };

  const handleKindChange = (entryId: string, newKind: string, oldKind: string): void => {
    optimisticUpdate(entryId, { kind: newKind }, { kind: oldKind });
  };

  const handleDateTimeCommit = (entryId: string, newTs: string, oldTs: string): void => {
    optimisticUpdate(entryId, { ts: newTs }, { ts: oldTs });
  };

  const handleAccountCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    if (newValue === null) return;
    optimisticUpdate(entryId, { accountId: newValue }, { accountId: oldValue ?? "" });
  };

  const handleAmountCommit = (entryId: string, newAmount: number, oldAmount: number): void => {
    optimisticUpdate(entryId, { amount: newAmount }, { amount: oldAmount });
  };

  const handleCurrencyCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    if (newValue === null) return;
    optimisticUpdate(entryId, { currency: newValue }, { currency: oldValue ?? "" });
  };

  const columns: ReadonlyArray<ColumnDef<LedgerEntry>> = (() => {
    const editableDateCol: ColumnDef<LedgerEntry> = {
      key: "date",
      header: "Date",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableDateTime
          key="date"
          entryId={row.entryId}
          currentValue={row.ts}
          maskClass={getMaskClass(row.category)}
          onDateTimeCommit={handleDateTimeCommit}
        />
      ),
      rightAlign: false,
      sortKey: "ts",
    };

    const editableAccountCol: ColumnDef<LedgerEntry> = {
      key: "account",
      header: "Account",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableText
          key="account"
          entryId={row.entryId}
          currentValue={row.accountId}
          maskClass={getMaskClass(row.category)}
          onCommit={handleAccountCommit}
          hints={hints.accounts}
        />
      ),
      rightAlign: false,
      sortKey: "accountId",
    };

    const editableAmountCol: ColumnDef<LedgerEntry> = {
      key: "amount",
      header: "Amount",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableAmount
          key="amount"
          entryId={row.entryId}
          currentValue={row.amount}
          maskClass={getMaskClass(row.category)}
          onAmountCommit={handleAmountCommit}
        />
      ),
      rightAlign: true,
      sortKey: "amount",
    };

    const editableCurrencyCol: ColumnDef<LedgerEntry> = {
      key: "currency",
      header: "Currency",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableText
          key="currency"
          entryId={row.entryId}
          currentValue={row.currency}
          maskClass={getMaskClass(row.category)}
          onCommit={handleCurrencyCommit}
          hints={hints.currencies}
        />
      ),
      rightAlign: false,
      sortKey: "currency",
    };

    const editableKindCol: ColumnDef<LedgerEntry> = {
      key: "kind",
      header: "Kind",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableKind
          key="kind"
          entry={row}
          maskClass={getMaskClass(row.category)}
          onKindChange={handleKindChange}
        />
      ),
      rightAlign: false,
      sortKey: "kind",
    };

    const editableCategoryCol: ColumnDef<LedgerEntry> = {
      key: "category",
      header: "Category",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableCategory
          key="category"
          entry={row}
          categories={categories}
          maskClass={getMaskClass(row.category)}
          onCategoryChange={handleCategoryChange}
        />
      ),
      rightAlign: false,
      sortKey: "category",
    };

    const editableCounterpartyCol: ColumnDef<LedgerEntry> = {
      key: "counterparty",
      header: "Counterparty",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableText
          key="counterparty"
          entryId={row.entryId}
          currentValue={row.counterparty}
          maskClass={getMaskClass(row.category)}
          onCommit={handleCounterpartyCommit}
          hints={hints.counterparties}
        />
      ),
      rightAlign: false,
      sortKey: "counterparty",
    };

    const editableNoteCol: ColumnDef<LedgerEntry> = {
      key: "note",
      header: "Note",
      renderCell: (row: LedgerEntry): ReactElement => (
        <EditableText
          key="note"
          entryId={row.entryId}
          currentValue={row.note}
          maskClass={getMaskClass(row.category)}
          onCommit={handleNoteCommit}
          cellClass="txn-cell-note"
          hints={hints.notes}
        />
      ),
      rightAlign: false,
      sortKey: null,
    };

    return [editableDateCol, editableAccountCol, editableAmountCol, editableCurrencyCol, editableKindCol, editableCategoryCol, editableCounterpartyCol, editableNoteCol];
  })();

  return (
    <>
      <div className="txn-filters">
        <label className="txn-filter-label">
          From
          <input
            type="date"
            className="txn-filter-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          To
          <input
            type="date"
            className="txn-filter-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          Account
          <select
            className="txn-filter-input"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>{a.accountId}</option>
            ))}
          </select>
        </label>
        {!scroll.loading && (
          <span className="txn-filter-count">
            {scroll.rows.length} of {scroll.total} entries
          </span>
        )}
      </div>

      {scroll.error !== null && (
        <div className="budget-alert">
          <strong>Failed to load transactions</strong>
          <span>{scroll.error}</span>
        </div>
      )}

      <div className="txn-scroll">
        <DataTable<LedgerEntry>
          columns={columns}
          rows={scroll.rows}
          rowKey={(row, idx) => `${row.entryId}-${idx}`}
          sort={sort}
          onSort={onSort}
          emptyMessage="No entries match the selected filters."
          loading={scroll.loading}
          loadingMore={scroll.loadingMore}
          sentinelRef={scroll.sentinelRef}
        />
      </div>
    </>
  );
};
