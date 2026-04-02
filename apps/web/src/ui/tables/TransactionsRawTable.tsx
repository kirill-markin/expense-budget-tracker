"use client";

import { type ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchLiveData } from "@/lib/liveDataFetch";
import type { AccountOption, FieldHints, LedgerEntry, TransactionsPage } from "@/server/transactions/getTransactions";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import alertStyles from "@/ui/Alert.module.css";

import { DataTable } from "./data-table/DataTable";
import { FilterMultiSelect, type FilterMultiSelectOption } from "./FilterMultiSelect";
import tableStyles from "./TableUi.module.css";
import type { ColumnDef, PageResult } from "./data-table/types";
import { useTableSort } from "./data-table/useTableSort";
import {
  buildTransactionsCreateEntryRequest,
  buildTransactionsPageUrl,
  CREATE_ERROR_PREFIX,
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
} from "./transactionColumns";

type Props = Readonly<{
  accounts: ReadonlyArray<AccountOption>;
  categories: ReadonlyArray<string>;
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
  const { accounts, categories, hints, refreshToken } = props;
  const { t } = useTranslation();
  const { effectiveAllowlist } = useFilteredMode();

  const getMaskClass = (category: string | null): string => {
    if (effectiveAllowlist === null) return "";
    if (category !== null && effectiveAllowlist.has(category)) return "";
    return " data-masked";
  };
  const getRowMaskClass = useCallback((row: LedgerEntry): string => getMaskClass(row.category), [effectiveAllowlist]);

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [dateFrom, setDateFrom] = useState<string>(toDateInputValue(ninetyDaysAgo));
  const [dateTo, setDateTo] = useState<string>(toDateInputValue(now));
  const [selectedAccountIds, setSelectedAccountIds] = useState<ReadonlyArray<string>>([]);
  const [selectedCategories, setSelectedCategories] = useState<ReadonlyArray<string>>([]);

  const { sort, onSort } = useTableSort("single", "ts", "desc", SORT_DEFAULTS);
  const selectedAccountIdsKey = selectedAccountIds.join("\u0001");
  const selectedCategoriesKey = selectedCategories.join("\u0001");

  const accountOptions = useMemo<ReadonlyArray<FilterMultiSelectOption>>(
    () => accounts.map((account) => ({ value: account.accountId, label: account.accountId })),
    [accounts],
  );

  const categoryOptions = useMemo<ReadonlyArray<FilterMultiSelectOption>>(
    () => [
      { value: "", label: t("txn.filterUncategorized") },
      ...categories.map((category) => ({ value: category, label: category })),
    ],
    [categories, t],
  );

  // The transactions header/filter options refresh through the server
  // component. The row list is fetched separately on the client, so it needs
  // the same refresh identity in its URL to ensure the post-refresh read is
  // observably newer than the pre-refresh read.
  const fetchPage = useCallback(async (limit: number, offset: number): Promise<PageResult<LedgerEntry>> => {
    const url = buildTransactionsPageUrl(
      dateFrom,
      dateTo,
      selectedAccountIds,
      selectedCategories,
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
  }, [dateFrom, dateTo, refreshToken, selectedAccountIds, selectedCategories, sort]);

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
    createEntryRequest: () => buildTransactionsCreateEntryRequest(dateTo, selectedAccountIds),
    resetDeps: [dateFrom, dateTo, selectedAccountIdsKey, selectedCategoriesKey, sort[0].key, sort[0].dir, refreshToken],
    onDirty: () => {},
  });

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
    editableDateColumn(getRowMaskClass, handleDateTimeCommit),
    editableAccountColumn(getRowMaskClass, handleAccountCommit, hints.accounts),
    editableAmountColumn(getRowMaskClass, handleAmountCommit),
    editableCurrencyColumn(getRowMaskClass, handleCurrencyCommit, hints.currencies),
    editableKindColumn(getRowMaskClass, handleKindChange),
    editableCategoryColumn(getRowMaskClass, categories, handleCategoryChange),
    editableCounterpartyColumn(getRowMaskClass, handleCounterpartyCommit, hints.counterparties),
    editableNoteColumn(getRowMaskClass, handleNoteCommit, hints.notes),
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
      <div className={tableStyles.filters}>
        <label className={tableStyles.filterLabel}>
          {t("common.from")}
          <input
            type="date"
            className={tableStyles.filterInput}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className={tableStyles.filterLabel}>
          {t("common.to")}
          <input
            type="date"
            className={tableStyles.filterInput}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <FilterMultiSelect
          label={t("table.account")}
          options={accountOptions}
          selectedValues={selectedAccountIds}
          onChange={setSelectedAccountIds}
          testId="transactions-account-filter"
        />
        <FilterMultiSelect
          label={t("table.category")}
          options={categoryOptions}
          selectedValues={selectedCategories}
          onChange={setSelectedCategories}
          testId="transactions-category-filter"
        />
        {!loading && (
          <span className={tableStyles.filterCount}>
            {t("txn.countLabel", { shown: rows.length, total })}
          </span>
        )}
        <button type="button" className={tableStyles.addRowButton} onClick={addRow}>
          {t("txn.addRow")}
        </button>
      </div>

      {errorMessage !== null && (
        <div className={alertStyles.alert}>
          <strong>{errorTitle}</strong>
          <span>{errorMessage}</span>
        </div>
      )}

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
