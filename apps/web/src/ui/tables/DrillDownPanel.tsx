"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchWithCsrf } from "@/lib/csrf";
import type { FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFormat } from "@/ui/FormatProvider";
import alertStyles from "@/ui/Alert.module.css";

import { DataTable } from "./data-table/DataTable";
import tableStyles from "./TableUi.module.css";
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
  categories: ReadonlyArray<string> | null;
}>;

type Props = Readonly<{
  filter: DrillDownFilter;
  categories: ReadonlyArray<string>;
  hints: FieldHints;
  onClose: (dirty: boolean) => void;
}>;
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
  if (filter.categories !== null) {
    for (const cat of filter.categories) {
      params.append("categories", cat);
    }
  }
  params.set("sortKey", sortKey);
  params.set("sortDir", sortDir);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/api/transactions?${params.toString()}`;
};

const buildTitle = (filter: DrillDownFilter): string => {
  if (filter.category !== null) {
    const category = filter.category === "" ? "Uncategorized" : filter.category;
    if (filter.direction === null) return category;
    const direction = filter.direction.charAt(0).toUpperCase() + filter.direction.slice(1);
    return `${direction} \u2014 ${category}`;
  }
  if (filter.direction === null) return "All categories";
  const direction = filter.direction.charAt(0).toUpperCase() + filter.direction.slice(1);
  if (filter.categories !== null) return direction;
  return `${direction} \u2014 All categories`;
};

const buildSubtitle = (filter: DrillDownFilter): string => {
  return `${filter.dateFrom} \u2013 ${filter.dateTo}`;
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

export const DrillDownPanel = (props: Props): ReactElement => {
  const { filter, categories, hints, onClose } = props;
  const { numberFormat } = useFormat();
  const { t } = useTranslation();

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [createdRows, setCreatedRows] = useState<ReadonlyArray<LedgerEntry>>([]);

  const { sort, onSort } = useTableSort("single", "amountUsdAbs", "desc", DRILLDOWN_SORT_DEFAULTS);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const dirtyRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const isRtl = document.documentElement.dir === "rtl";
      const newWidth = isRtl ? e.clientX : window.innerWidth - e.clientX;
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
  const rows = mergeRows(createdRows, scroll.rows);
  const categoriesKey = filter.categories?.join("\u0001") ?? "";

  const closePanel = useCallback((): void => {
    onClose(dirtyRef.current);
  }, [onClose]);

  useEffect(() => {
    setCreatedRows([]);
  }, [filter.dateFrom, filter.dateTo, filter.direction, filter.category, categoriesKey, sort[0].key, sort[0].dir]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        closePanel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel]);

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

    dirtyRef.current = true;

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
      ts: toLocalNoonIso(filter.dateTo),
      accountId: "",
      amount: 0,
      currency: "",
      kind: filter.direction ?? "spend",
      category: filter.category === null ? null : (filter.category === "" ? null : filter.category),
      counterparty: null,
      note: null,
    };

    createEntry(request)
      .then((entry) => {
        dirtyRef.current = true;
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

    dirtyRef.current = true;
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
          cellClass={tableStyles.cellNote}
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
        <span className={tableStyles.cellDelete}>
          <button
            type="button"
            className={tableStyles.deleteButton}
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
      { ...usdColumn(numberFormat), sortKey: "amountUsdAbs" },
      editableKindCol, editableCategoryCol, editableCounterpartyCol, editableNoteCol, deleteCol,
    ];
  })();
  const errorTitle = scroll.error !== null && scroll.error.startsWith(CREATE_ERROR_PREFIX)
    ? t("txn.failedToCreate")
    : t("txn.failedToLoad");
  const errorMessage = scroll.error !== null && scroll.error.startsWith(CREATE_ERROR_PREFIX)
    ? scroll.error.slice(CREATE_ERROR_PREFIX.length)
    : scroll.error;

  return (
    <>
      <div className={tableStyles.overlayBackdrop} onClick={closePanel} />
      <div className={tableStyles.sidePanel} ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={cn(tableStyles.panelResizeHandle, isDragging ? tableStyles.panelResizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className={tableStyles.panelHeader}>
          <div>
            <div className={tableStyles.panelTitle}>{buildTitle(filter)}</div>
            <div className={tableStyles.panelSubtitle}>{buildSubtitle(filter)}</div>
          </div>
          <div className={tableStyles.panelHeaderActions}>
            <button className={tableStyles.addRowButton} type="button" onClick={handleAddRow}>
              {t("txn.addRow")}
            </button>
            <button className={tableStyles.panelCloseButton} type="button" onClick={closePanel}>
              &times;
            </button>
          </div>
        </div>

        {!scroll.loading && (
          <div className={tableStyles.panelCount}>
            {scroll.total} {scroll.total === 1 ? "entry" : "entries"}
          </div>
        )}

        {errorMessage !== null && (
          <div className={alertStyles.alert} style={{ margin: "8px 16px" }}>
            <strong>{errorTitle}</strong>
            <span>{errorMessage}</span>
          </div>
        )}

        <div className={tableStyles.panelBody}>
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
      </div>
    </>
  );
};
