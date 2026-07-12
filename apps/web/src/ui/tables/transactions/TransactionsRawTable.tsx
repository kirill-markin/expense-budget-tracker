"use client";

import { type ReactElement } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchLiveData } from "@/lib/liveDataFetch";
import { getCellVisibility } from "@/lib/dataMask";
import type { FieldHints, LedgerEntry, TransactionsFilterOptions, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import alertStyles from "@/ui/Alert.module.css";
import filterStyles from "@/ui/FilterControls.module.css";

import { DataTable } from "@/ui/tables/shared/data-table/DataTable";
import type { ColumnDef, PageResult } from "@/ui/tables/shared/data-table/types";
import { useTableSort } from "@/ui/tables/shared/data-table/useTableSort";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import transactionStyles from "./TransactionsTable.module.css";
import { TransactionCopyFeedback } from "./TransactionCopyFeedback";
import { serializeFilterValues } from "./filters/transactionsFiltersState";
import {
  TransactionsFiltersOverlay,
  type TransactionsFiltersOverlayOptions,
} from "./filters/TransactionsFiltersOverlay";
import {
  buildTransactionsCreateEntryRequest,
  buildTransactionsPageUrl,
  CREATE_ERROR_PREFIX,
  UPDATE_ERROR_PREFIX,
  type TransactionsTableFilter,
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
  transactionCopyColumn,
} from "./editing/transactionColumns";
import { useTransactionClipboard } from "./useTransactionClipboard";

type Props = Readonly<{
  filterOptions: TransactionsFilterOptions;
  hints: FieldHints;
  refreshToken: string;
}>;

const SORT_DEFAULTS: Readonly<Record<string, "asc" | "desc">> = { amount: "desc" };

const toDateInputValue = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export const TransactionsRawTable = (props: Props): ReactElement => {
  const { filterOptions, hints, refreshToken } = props;
  const { t } = useTranslation();
  const { effectiveAllowlist } = useFilteredMode();
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const { feedback: copyFeedback, copyTransaction } = useTransactionClipboard(
    t("txn.copySuccess"),
    t("txn.copyFailed"),
  );

  const getRowMaskClass = useCallback(
    (row: LedgerEntry): string => getCellVisibility(effectiveAllowlist, row.category).maskClass,
    [effectiveAllowlist],
  );

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [dateFrom, setDateFrom] = useState<string>(toDateInputValue(ninetyDaysAgo));
  const [dateTo, setDateTo] = useState<string>(toDateInputValue(now));
  const [selectedAccountIds, setSelectedAccountIds] = useState<ReadonlyArray<string>>([]);
  const [selectedCategories, setSelectedCategories] = useState<ReadonlyArray<string>>([]);
  const [selectedKinds, setSelectedKinds] = useState<ReadonlyArray<string>>([]);
  const [selectedCurrencies, setSelectedCurrencies] = useState<ReadonlyArray<string>>([]);
  const [selectedCounterparties, setSelectedCounterparties] = useState<ReadonlyArray<string>>([]);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);

  const { sort, onSort } = useTableSort("single", "ts", "desc", SORT_DEFAULTS);
  const selectedAccountIdsKey = serializeFilterValues(selectedAccountIds);
  const selectedCategoriesKey = serializeFilterValues(selectedCategories);
  const selectedKindsKey = serializeFilterValues(selectedKinds);
  const selectedCurrenciesKey = serializeFilterValues(selectedCurrencies);
  const selectedCounterpartiesKey = serializeFilterValues(selectedCounterparties);

  const filterValues = useMemo<TransactionsTableFilter>(
    () => ({
      dateFrom,
      dateTo,
      accountIds: selectedAccountIds,
      categories: selectedCategories,
      kinds: selectedKinds,
      currencies: selectedCurrencies,
      counterparties: selectedCounterparties,
    }),
    [dateFrom, dateTo, selectedAccountIds, selectedCategories, selectedKinds, selectedCurrencies, selectedCounterparties],
  );

  const overlayOptions = useMemo<TransactionsFiltersOverlayOptions>(
    () => ({
      accountIds: filterOptions.accounts.map((accountId) => ({ value: accountId, label: accountId })),
      categories: [
        { value: "", label: t("txn.filterUncategorized") },
        ...filterOptions.categories.map((category) => ({ value: category, label: category })),
      ],
      kinds: filterOptions.kinds.map((kind) => ({
        value: kind,
        label: kind.charAt(0).toUpperCase() + kind.slice(1),
      })),
      currencies: filterOptions.currencies.map((currency) => ({ value: currency, label: currency })),
      counterparties: [
        { value: "", label: t("txn.filterNoCounterparty") },
        ...filterOptions.counterparties.map((counterparty) => ({ value: counterparty, label: counterparty })),
      ],
    }),
    [filterOptions, t],
  );

  const activeFilterGroupCount = useMemo<number>(
    () => [
      selectedAccountIds,
      selectedCategories,
      selectedKinds,
      selectedCurrencies,
      selectedCounterparties,
    ].filter((items) => items.length > 0).length,
    [selectedAccountIds, selectedCategories, selectedKinds, selectedCurrencies, selectedCounterparties],
  );

  // The transactions header/filter options refresh through the server
  // component. The row list is fetched separately on the client, so it needs
  // the same refresh identity in its URL to ensure the post-refresh read is
  // observably newer than the pre-refresh read.
  const fetchPage = useCallback(async (limit: number, offset: number): Promise<PageResult<LedgerEntry>> => {
    const url = buildTransactionsPageUrl(
      filterValues,
      sort[0].key,
      sort[0].dir,
      refreshToken,
      limit,
      offset,
    );
    const response = await fetchLiveData(url);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status}: ${text}`);
    }
    const page: TransactionsPage = await response.json();
    return { items: page.entries, total: page.total };
  }, [filterValues, refreshToken, sort]);

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
    createEntryRequest: () => buildTransactionsCreateEntryRequest(dateTo, selectedAccountIds),
    resetDeps: [
      dateFrom,
      dateTo,
      selectedAccountIdsKey,
      selectedCategoriesKey,
      selectedKindsKey,
      selectedCurrenciesKey,
      selectedCounterpartiesKey,
      sort[0].key,
      sort[0].dir,
      refreshToken,
    ],
    onDirty: () => {},
  });

  const handleFiltersChange = (nextValues: TransactionsTableFilter): void => {
    setSelectedAccountIds(nextValues.accountIds);
    setSelectedCategories(nextValues.categories);
    setSelectedKinds(nextValues.kinds);
    setSelectedCurrencies(nextValues.currencies);
    setSelectedCounterparties(nextValues.counterparties);
  };

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
    editableDateColumn(getRowMaskClass, handleDateTimeCommit),
    editableAccountColumn(getRowMaskClass, handleAccountCommit, hints.accounts),
    editableAmountColumn(getRowMaskClass, handleAmountCommit),
    editableCurrencyColumn(getRowMaskClass, handleCurrencyCommit, hints.currencies),
    editableKindColumn(getRowMaskClass, handleKindChange),
    editableCategoryColumn(getRowMaskClass, filterOptions.categories, handleCategoryChange),
    editableCounterpartyColumn(getRowMaskClass, handleCounterpartyCommit, hints.counterparties),
    editableNoteColumn(getRowMaskClass, handleNoteCommit, hints.notes),
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
      <div className={filterStyles.filters}>
        <label className={filterStyles.filterLabel}>
          {t("common.from")}
          <input
            type="date"
            className={filterStyles.filterInput}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className={filterStyles.filterLabel}>
          {t("common.to")}
          <input
            type="date"
            className={filterStyles.filterInput}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <div className={filterStyles.filterLabel}>
          {t("txn.filtersButton")}
          <button
            ref={filtersTriggerRef}
            type="button"
            className={[
              filterStyles.filterInput,
              filterStyles.filterTrigger,
              transactionStyles.transactionsFiltersTrigger,
              filtersOpen ? filterStyles.filterTriggerOpen : "",
            ].join(" ")}
            onClick={() => setFiltersOpen((current) => !current)}
            data-testid="transactions-filters-trigger"
          >
            <span className={filterStyles.filterTriggerText}>{t("txn.filtersButton")}</span>
            {activeFilterGroupCount > 0 && (
              <span className={transactionStyles.transactionsFiltersTriggerBadge} data-testid="transactions-filters-badge">
                {activeFilterGroupCount}
              </span>
            )}
          </button>
        </div>
        {!loading && (
          <span className={transactionStyles.filterCount}>
            {t("txn.countLabel", { shown: rows.length, total })}
          </span>
        )}
        <button type="button" className={transactionStyles.addRowButton} onClick={addRow}>
          {t("txn.addRow")}
        </button>
      </div>

      {filtersOpen && (
        <TransactionsFiltersOverlay
          triggerRef={filtersTriggerRef}
          values={filterValues}
          options={overlayOptions}
          onChange={handleFiltersChange}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      {errorMessage !== null && (
        <div className={alertStyles.alert}>
          <strong>{errorTitle}</strong>
          <span>{errorMessage}</span>
        </div>
      )}

      <TransactionCopyFeedback feedback={copyFeedback} />

      <div className={tableStyles.scroll}>
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
    </>
  );
};
