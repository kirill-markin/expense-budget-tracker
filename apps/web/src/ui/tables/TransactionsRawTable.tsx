"use client";

import { type ReactElement } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchWithCsrf } from "@/lib/csrf";
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
type CreateLedgerEntryRequest = Readonly<{
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
  kind: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

const PAGE_SIZE = 100;
const CREATE_ERROR_PREFIX = "__create__:";

const SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = { amount: "desc" };

const toDateInputValue = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const toLocalNoonIso = (dateValue: string): string => {
  return new Date(`${dateValue}T12:00`).toISOString();
};

const mergeRows = (
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

const deleteEntry = async (entryId: string): Promise<void> => {
  const response = await fetchWithCsrf("/api/transactions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
  if (!response.ok) {
    throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
  }
};

const saveEntry = async (entry: LedgerEntry): Promise<void> => {
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

const createEntry = async (entry: CreateLedgerEntryRequest): Promise<LedgerEntry> => {
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

export const TransactionsRawTable = (props: Props): ReactElement => {
  const { accounts, categories, hints } = props;
  const { t } = useTranslation();
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
  const [createdRows, setCreatedRows] = useState<ReadonlyArray<LedgerEntry>>([]);

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
  const rows = mergeRows(createdRows, scroll.rows);

  useEffect(() => {
    setCreatedRows([]);
  }, [dateFrom, dateTo, selectedAccount, sort[0].key, sort[0].dir]);

  const replaceEntry = (entry: LedgerEntry): void => {
    setCreatedRows((prev) => prev.map((item) => (item.entryId === entry.entryId ? entry : item)));
    scroll.setRows((prev) => prev.map((item) => (item.entryId === entry.entryId ? entry : item)));
  };

  const optimisticUpdate = (
    entryId: string,
    patch: Partial<LedgerEntry>,
  ): void => {
    const entry = rows.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    const updated = { ...entry, ...patch };
    replaceEntry(updated);

    saveEntry(updated).catch((err: unknown) => {
      replaceEntry(entry);
      scroll.setError(err instanceof Error ? err.message : String(err));
    });
  };

  const handleCategoryChange = (entryId: string, newCategory: string | null, oldCategory: string | null): void => {
    void oldCategory;
    optimisticUpdate(entryId, { category: newCategory });
  };

  const handleNoteCommit = (entryId: string, newNote: string | null, oldNote: string | null): void => {
    void oldNote;
    optimisticUpdate(entryId, { note: newNote });
  };

  const handleCounterpartyCommit = (entryId: string, newCounterparty: string | null, oldCounterparty: string | null): void => {
    void oldCounterparty;
    optimisticUpdate(entryId, { counterparty: newCounterparty });
  };

  const handleKindChange = (entryId: string, newKind: string, oldKind: string): void => {
    void oldKind;
    optimisticUpdate(entryId, { kind: newKind });
  };

  const handleDateTimeCommit = (entryId: string, newTs: string, oldTs: string): void => {
    void oldTs;
    optimisticUpdate(entryId, { ts: newTs });
  };

  const handleAccountCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    void oldValue;
    optimisticUpdate(entryId, { accountId: newValue ?? "" });
  };

  const handleAmountCommit = (entryId: string, newAmount: number, oldAmount: number): void => {
    void oldAmount;
    optimisticUpdate(entryId, { amount: newAmount });
  };

  const handleCurrencyCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    void oldValue;
    optimisticUpdate(entryId, { currency: newValue ?? "" });
  };

  const handleAddRow = (): void => {
    scroll.setError(null);
    const request: CreateLedgerEntryRequest = {
      ts: toLocalNoonIso(dateTo),
      accountId: selectedAccount,
      amount: 0,
      currency: "",
      kind: "spend",
      category: null,
      counterparty: null,
      note: null,
    };

    createEntry(request)
      .then((entry) => {
        setCreatedRows((prev) => [entry, ...prev.filter((item) => item.entryId !== entry.entryId)]);
        scroll.setTotal((prev) => prev + 1);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        scroll.setError(`${CREATE_ERROR_PREFIX}${message}`);
      });
  };

  const handleDelete = (entryId: string): void => {
    if (!window.confirm(t("txn.deleteConfirm"))) return;

    const entry = rows.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    const prevCreatedRows = createdRows;
    const prevFetchedRows = scroll.rows;
    const prevTotal = scroll.total;
    setCreatedRows((prev) => prev.filter((e) => e.entryId !== entryId));
    scroll.setRows((prev) => prev.filter((e) => e.entryId !== entryId));
    scroll.setTotal((prev) => prev - 1);

    deleteEntry(entryId).catch((err: unknown) => {
      setCreatedRows(prevCreatedRows);
      scroll.setRows(prevFetchedRows);
      scroll.setTotal(prevTotal);
      scroll.setError(err instanceof Error ? err.message : String(err));
    });
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
          allowEmptyString={true}
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
          allowEmptyString={true}
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

    const deleteCol: ColumnDef<LedgerEntry> = {
      key: "delete",
      header: "",
      renderCell: (row: LedgerEntry): ReactElement => (
        <span className="txn-cell-delete">
          <button
            type="button"
            className="txn-delete-btn"
            onClick={() => handleDelete(row.entryId)}
          >
            &#x2715;
          </button>
        </span>
      ),
      rightAlign: false,
      sortKey: null,
    };

    return [editableDateCol, editableAccountCol, editableAmountCol, editableCurrencyCol, editableKindCol, editableCategoryCol, editableCounterpartyCol, editableNoteCol, deleteCol];
  })();
  const errorTitle = scroll.error !== null && scroll.error.startsWith(CREATE_ERROR_PREFIX)
    ? t("txn.failedToCreate")
    : t("txn.failedToLoad");
  const errorMessage = scroll.error !== null && scroll.error.startsWith(CREATE_ERROR_PREFIX)
    ? scroll.error.slice(CREATE_ERROR_PREFIX.length)
    : scroll.error;

  return (
    <>
      <div className="txn-filters">
        <label className="txn-filter-label">
          {t("common.from")}
          <input
            type="date"
            className="txn-filter-input"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          {t("common.to")}
          <input
            type="date"
            className="txn-filter-input"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="txn-filter-label">
          {t("table.account")}
          <select
            className="txn-filter-input"
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">{t("mode.all")}</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>{a.accountId}</option>
            ))}
          </select>
        </label>
        {!scroll.loading && (
          <span className="txn-filter-count">
            {t("txn.countLabel", { shown: rows.length, total: scroll.total })}
          </span>
        )}
        <button type="button" className="txn-add-row-btn" onClick={handleAddRow}>
          {t("txn.addRow")}
        </button>
      </div>

      {errorMessage !== null && (
        <div className="budget-alert">
          <strong>{errorTitle}</strong>
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="txn-scroll">
        <DataTable<LedgerEntry>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.entryId}
          sort={sort}
          onSort={onSort}
          emptyMessage={t("txn.noMatch")}
          loading={scroll.loading}
          loadingMore={scroll.loadingMore}
          sentinelRef={scroll.sentinelRef}
        />
      </div>
    </>
  );
};
