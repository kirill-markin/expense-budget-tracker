"use client";

import { type ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { getCellVisibility } from "@/lib/dataMask";
import { fetchLiveData } from "@/lib/liveDataFetch";
import type { FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFormat } from "@/ui/FormatProvider";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import alertStyles from "@/ui/Alert.module.css";

import { DataTable } from "@/ui/tables/shared/data-table/DataTable";
import type { ColumnDef, PageResult } from "@/ui/tables/shared/data-table/types";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import panelStyles from "@/ui/tables/shared/TablePanel.module.css";
import { useTableSort } from "@/ui/tables/shared/data-table/useTableSort";
import {
  buildDrillDownCreateEntryRequest,
  buildDrillDownPageUrl,
  CREATE_ERROR_PREFIX,
  UPDATE_ERROR_PREFIX,
  useEditableTransactionsTable,
} from "./editing/useEditableTransactionsTable";
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
  reportAmountColumn,
  transactionCopyColumn,
} from "./editing/transactionColumns";
import transactionStyles from "./TransactionsTable.module.css";
import { TransactionCopyFeedback } from "./TransactionCopyFeedback";
import { useTransactionClipboard } from "./useTransactionClipboard";

type Props = Readonly<{
  filter: DrillDownFilter;
  categories: ReadonlyArray<string>;
  hints: FieldHints;
  reportingCurrency: string;
  refreshToken: string;
  onClose: (dirty: boolean) => void;
}>;

const DRILLDOWN_SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = {
  amount: "desc",
  amountReportAbs: "desc",
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
  const { filter, categories, hints, reportingCurrency, refreshToken, onClose } = props;
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const { effectiveAllowlist } = useFilteredMode();
  const { feedback: copyFeedback, copyTransaction } = useTransactionClipboard(
    t("txn.copySuccess"),
    t("txn.copyFailed"),
  );
  const title = filter.businessPersonalTransfers ? t("budget.businessPersonalTransfer") : buildTitle(filter);
  const getMaskClass = useCallback(
    (row: LedgerEntry): string => getCellVisibility(effectiveAllowlist, row.category).maskClass,
    [effectiveAllowlist],
  );

  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const { sort, onSort } = useTableSort("single", "amountReportAbs", "desc", DRILLDOWN_SORT_DEFAULTS);

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
    const url = buildDrillDownPageUrl(filter, sort[0].key, sort[0].dir, refreshToken, limit, offset);
    const response = await fetchLiveData(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();
    return { items: page.entries, total: page.total };
  }, [filter, refreshToken, sort]);

  const {
    rows,
    total,
    loading,
    loadingMore,
    error,
    pendingEntryIds,
    sentinelRef,
    addRow,
    updateEntry,
    deleteEntry,
  } = useEditableTransactionsTable({
    fetchPage,
    createEntryRequest: () => buildDrillDownCreateEntryRequest(filter),
    resetDeps: [filter.dateFrom, filter.dateTo, filter.direction, filter.category, categoriesKey, filter.businessPersonalTransfers, sort[0].key, sort[0].dir, refreshToken],
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
    transactionCopyColumn(effectiveAllowlist, pendingEntryIds, copyTransaction, t("txn.copyAction")),
    editableDateColumn(getMaskClass, handleDateTimeCommit),
    editableAccountColumn(getMaskClass, handleAccountCommit, hints.accounts),
    editableAmountColumn(getMaskClass, handleAmountCommit),
    editableCurrencyColumn(getMaskClass, handleCurrencyCommit, hints.currencies),
    { ...reportAmountColumn(numberFormat, reportingCurrency), sortKey: "amountReportAbs" },
    editableKindColumn(getMaskClass, handleKindChange),
    editableCategoryColumn(getMaskClass, categories, handleCategoryChange),
    editableCounterpartyColumn(getMaskClass, handleCounterpartyCommit, hints.counterparties),
    editableNoteColumn(getMaskClass, handleNoteCommit, hints.notes),
    editableDeleteColumn(handleDelete),
  ];
  const errorTitle = error !== null && error.startsWith(CREATE_ERROR_PREFIX)
    ? t("txn.failedToCreate")
    : error !== null && error.startsWith(UPDATE_ERROR_PREFIX)
      ? t("txn.failedToUpdate")
      : t("txn.failedToLoad");
  const errorMessage = error !== null && error.startsWith(CREATE_ERROR_PREFIX)
    ? error.slice(CREATE_ERROR_PREFIX.length)
    : error !== null && error.startsWith(UPDATE_ERROR_PREFIX)
      ? error.slice(UPDATE_ERROR_PREFIX.length)
      : error;

  return (
    <>
      <div className={panelStyles.overlayBackdrop} onClick={closePanel} />
      <div className={panelStyles.sidePanel} ref={panelRef} style={panelWidth !== null ? { width: panelWidth } : undefined}>
        <div
          className={cn(panelStyles.panelResizeHandle, isDragging ? panelStyles.panelResizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
        <div className={panelStyles.panelHeader}>
          <div>
            <div className={panelStyles.panelTitle}>{title}</div>
            <div className={panelStyles.panelSubtitle}>{buildSubtitle(filter)}</div>
          </div>
          <div className={panelStyles.panelHeaderActions}>
            {!filter.businessPersonalTransfers && (
              <button className={transactionStyles.addRowButton} type="button" onClick={addRow}>
                {t("txn.addRow")}
              </button>
            )}
            <button className={panelStyles.panelCloseButton} type="button" onClick={closePanel}>
              &times;
            </button>
          </div>
        </div>

        {!loading && (
          <div className={panelStyles.panelCount}>
            {total} {total === 1 ? "entry" : "entries"}
          </div>
        )}

        {errorMessage !== null && (
          <div className={alertStyles.alert} style={{ margin: "8px 16px" }}>
            <strong>{errorTitle}</strong>
            <span>{errorMessage}</span>
          </div>
        )}

        <TransactionCopyFeedback feedback={copyFeedback} />

        <div className={panelStyles.panelBody}>
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
