"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { fetchLiveData } from "@/lib/liveDataFetch";
import type { FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFormat } from "@/ui/FormatProvider";
import alertStyles from "@/ui/Alert.module.css";

import { DataTable } from "./data-table/DataTable";
import tableStyles from "./TableUi.module.css";
import type { ColumnDef, PageResult } from "./data-table/types";
import { useTableSort } from "./data-table/useTableSort";
import {
  buildDrillDownCreateEntryRequest,
  buildDrillDownPageUrl,
  CREATE_ERROR_PREFIX,
  type DrillDownFilter,
  useEditableTransactionsTable,
} from "./useEditableTransactionsTable";
import {
  editableAccountColumn,
  editableAmountColumn,
  editableCategoryColumn,
  editableCounterpartyColumn,
  editableCurrencyColumn,
  editableDateColumn,
  editableDeleteColumn,
  editableKindColumn,
  editableNoteColumn,
  usdColumn,
} from "./transactionColumns";

export type { DrillDownFilter } from "./useEditableTransactionsTable";

type Props = Readonly<{
  filter: DrillDownFilter;
  categories: ReadonlyArray<string>;
  hints: FieldHints;
  onClose: (dirty: boolean) => void;
}>;

const DRILLDOWN_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  amount: "desc",
  amountUsdAbs: "desc",
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

export const DrillDownPanel = (props: Props): ReactElement => {
  const { filter, categories, hints, onClose } = props;
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const getMaskClass = useCallback((row: LedgerEntry): string => {
    void row;
    return "";
  }, []);

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const { sort, onSort } = useTableSort("single", "amountUsdAbs", "desc", DRILLDOWN_SORT_DEFAULTS);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const dirtyRef = useRef<boolean>(false);
  const categoriesKey = filter.categories?.join("\u0001") ?? "";

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

  const fetchPage = useCallback(async (limit: number, offset: number): Promise<PageResult<LedgerEntry>> => {
    const url = buildDrillDownPageUrl(filter, sort[0].key, sort[0].dir, limit, offset);
    const response = await fetchLiveData(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();
    return { items: page.entries, total: page.total };
  }, [filter, sort]);

  const {
    rows,
    total,
    loading,
    loadingMore,
    error,
    sentinelRef,
    addRow,
    updateEntry,
    deleteEntry,
  } = useEditableTransactionsTable({
    fetchPage,
    createEntryRequest: () => buildDrillDownCreateEntryRequest(filter),
    resetDeps: [filter.dateFrom, filter.dateTo, filter.direction, filter.category, categoriesKey, sort[0].key, sort[0].dir],
    onDirty: () => {
      dirtyRef.current = true;
    },
  });

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

  const handleCategoryChange = (entryId: string, newCategory: string | null, oldCategory: string | null): void => {
    void oldCategory;
    updateEntry(entryId, { category: newCategory });
  };

  const handleNoteCommit = (entryId: string, newNote: string | null, oldNote: string | null): void => {
    void oldNote;
    updateEntry(entryId, { note: newNote });
  };

  const handleCounterpartyCommit = (entryId: string, newCounterparty: string | null, oldCounterparty: string | null): void => {
    void oldCounterparty;
    updateEntry(entryId, { counterparty: newCounterparty });
  };

  const handleKindChange = (entryId: string, newKind: string, oldKind: string): void => {
    void oldKind;
    updateEntry(entryId, { kind: newKind });
  };

  const handleDateTimeCommit = (entryId: string, newTs: string, oldTs: string): void => {
    void oldTs;
    updateEntry(entryId, { ts: newTs });
  };

  const handleAccountCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    void oldValue;
    updateEntry(entryId, { accountId: newValue ?? "" });
  };

  const handleAmountCommit = (entryId: string, newAmount: number, oldAmount: number): void => {
    void oldAmount;
    updateEntry(entryId, { amount: newAmount });
  };

  const handleCurrencyCommit = (entryId: string, newValue: string | null, oldValue: string | null): void => {
    void oldValue;
    updateEntry(entryId, { currency: newValue ?? "" });
  };

  const handleDelete = (entryId: string): void => {
    if (!window.confirm(t("txn.deleteConfirm"))) return;
    deleteEntry(entryId);
  };

  const columns: ReadonlyArray<ColumnDef<LedgerEntry>> = [
    editableDateColumn(getMaskClass, handleDateTimeCommit),
    editableAccountColumn(getMaskClass, handleAccountCommit, hints.accounts),
    editableAmountColumn(getMaskClass, handleAmountCommit),
    editableCurrencyColumn(getMaskClass, handleCurrencyCommit, hints.currencies),
    { ...usdColumn(numberFormat), sortKey: "amountUsdAbs" },
    editableKindColumn(getMaskClass, handleKindChange),
    editableCategoryColumn(getMaskClass, categories, handleCategoryChange),
    editableCounterpartyColumn(getMaskClass, handleCounterpartyCommit, hints.counterparties),
    editableNoteColumn(getMaskClass, handleNoteCommit, hints.notes),
    editableDeleteColumn(handleDelete),
  ];
  const errorTitle = error !== null && error.startsWith(CREATE_ERROR_PREFIX)
    ? t("txn.failedToCreate")
    : t("txn.failedToLoad");
  const errorMessage = error !== null && error.startsWith(CREATE_ERROR_PREFIX)
    ? error.slice(CREATE_ERROR_PREFIX.length)
    : error;

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
            <button className={tableStyles.addRowButton} type="button" onClick={addRow}>
              {t("txn.addRow")}
            </button>
            <button className={tableStyles.panelCloseButton} type="button" onClick={closePanel}>
              &times;
            </button>
          </div>
        </div>

        {!loading && (
          <div className={tableStyles.panelCount}>
            {total} {total === 1 ? "entry" : "entries"}
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
            loading={loading}
            loadingMore={loadingMore}
            sentinelRef={sentinelRef}
          />
        </div>
      </div>
    </>
  );
};
