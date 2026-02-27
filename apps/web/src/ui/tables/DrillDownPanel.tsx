"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";

import { DataTable } from "./data-table/DataTable";
import type { ColumnDef, PageResult } from "./data-table/types";
import { useInfiniteScroll } from "./data-table/useInfiniteScroll";
import { useTableSort } from "./data-table/useTableSort";
import { EditableAmount } from "./EditableAmount";
import { EditableCategory } from "./EditableCategory";
import { EditableDateTime } from "./EditableDateTime";
import { EditableKind } from "./EditableKind";
import { EditableText } from "./EditableText";
import { usdColumn } from "./transactionColumns";

export type DrillDownFilter = Readonly<{
  dateFrom: string;
  dateTo: string;
  direction: string | null;
  category: string | null;
}>;

type Props = Readonly<{
  filter: DrillDownFilter;
  categories: ReadonlyArray<string>;
  hints: FieldHints;
  onClose: (dirty: boolean) => void;
}>;

const PAGE_SIZE = 100;

const DRILLDOWN_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  amount: "desc",
  amountUsdAbs: "desc",
};

const buildUrl = (
  filter: DrillDownFilter,
  sortKey: string,
  sortDir: string,
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
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/transactions?${params.toString()}`;
};

const buildTitle = (filter: DrillDownFilter): string => {
  const category = filter.category ?? "All categories";
  if (filter.direction === null) return category;
  const direction = filter.direction.charAt(0).toUpperCase() + filter.direction.slice(1);
  return `${direction} \u2014 ${category}`;
};

const buildSubtitle = (filter: DrillDownFilter): string => {
  return `${filter.dateFrom} \u2013 ${filter.dateTo}`;
};

const deleteEntry = async (entryId: string): Promise<void> => {
  const response = await fetch("/api/transactions/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entryId }),
  });
  if (!response.ok) {
    throw new Error(`Delete failed: ${response.status} ${await response.text()}`);
  }
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

export const DrillDownPanel = (props: Props): ReactElement => {
  const { filter, categories, hints, onClose } = props;

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const { sort, onSort } = useTableSort("single", "amountUsdAbs", "desc", DRILLDOWN_SORT_DEFAULTS);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const dirtyRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const newWidth = window.innerWidth - e.clientX;
      const clamped = Math.max(320, Math.min(newWidth, window.innerWidth * 0.95));
      setPanelWidth(clamped);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging]);

  const fetchPage = async (limit: number, offset: number): Promise<PageResult<LedgerEntry>> => {
    const url = buildUrl(filter, sort[0].key, sort[0].dir, limit, offset);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();
    return { items: page.entries, total: page.total };
  };

  const scroll = useInfiniteScroll<LedgerEntry>(fetchPage, PAGE_SIZE, [filter, sort[0].key, sort[0].dir]);

  const closePanel = useCallback((): void => {
    onClose(dirtyRef.current);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closePanel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel]);

  const optimisticUpdate = (
    entryId: string,
    patch: Partial<LedgerEntry>,
    rollback: Partial<LedgerEntry>,
  ): void => {
    const entry = scroll.rows.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    dirtyRef.current = true;

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

  const handleDelete = (entryId: string): void => {
    if (!window.confirm("Delete this transaction? This cannot be undone.")) return;

    const entry = scroll.rows.find((e) => e.entryId === entryId);
    if (entry === undefined) return;

    dirtyRef.current = true;
    const rowIndex = scroll.rows.indexOf(entry);
    scroll.setRows((prev) => prev.filter((e) => e.entryId !== entryId));
    scroll.setTotal((prev) => prev - 1);

    deleteEntry(entryId).catch((err: unknown) => {
      scroll.setRows((prev) => [...prev.slice(0, rowIndex), entry, ...prev.slice(rowIndex)]);
      scroll.setTotal((prev) => prev + 1);
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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
          maskClass=""
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

    return [
      editableDateCol, editableAccountCol, editableAmountCol, editableCurrencyCol,
      { ...usdColumn(), sortKey: "amountUsdAbs" },
      editableKindCol, editableCategoryCol, editableCounterpartyCol, editableNoteCol, deleteCol,
    ];
  })();

  return (
    <>
      <div className="drilldown-overlay" onClick={closePanel} />
      <div className="drilldown-panel" ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={`drilldown-resize-handle${isDragging ? " dragging" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className="drilldown-header">
          <div>
            <div className="drilldown-title">{buildTitle(filter)}</div>
            <div className="drilldown-subtitle">{buildSubtitle(filter)}</div>
          </div>
          <button className="drilldown-close" type="button" onClick={closePanel}>
            &times;
          </button>
        </div>

        {!scroll.loading && (
          <div className="drilldown-count">
            {scroll.total} {scroll.total === 1 ? "entry" : "entries"}
          </div>
        )}

        {scroll.error !== null && (
          <div className="budget-alert" style={{ margin: "8px 16px" }}>
            <strong>Failed to load transactions</strong>
            <span>{scroll.error}</span>
          </div>
        )}

        <div className="drilldown-body">
          <DataTable<LedgerEntry>
            columns={columns}
            rows={scroll.rows}
            rowKey={(row, idx) => `${row.entryId}-${idx}`}
            sort={sort}
            onSort={onSort}
            emptyMessage="No entries found."
            loading={scroll.loading}
            loadingMore={scroll.loadingMore}
            sentinelRef={scroll.sentinelRef}
          />
        </div>
      </div>
    </>
  );
};
