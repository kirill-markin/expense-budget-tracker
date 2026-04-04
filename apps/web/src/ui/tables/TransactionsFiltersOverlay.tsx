"use client";

import { type CSSProperties, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";

import type { FilterMultiSelectOption } from "./FilterMultiSelect";
import tableStyles from "./TableUi.module.css";
import type { TransactionsTableFilter } from "./useEditableTransactionsTable";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type FilterSectionKey = "accountIds" | "categories" | "kinds" | "currencies" | "counterparties";

type SearchState = Readonly<Record<FilterSectionKey, string>>;

export type TransactionsFiltersOverlayOptions = Readonly<{
  accountIds: ReadonlyArray<FilterMultiSelectOption>;
  categories: ReadonlyArray<FilterMultiSelectOption>;
  kinds: ReadonlyArray<FilterMultiSelectOption>;
  currencies: ReadonlyArray<FilterMultiSelectOption>;
  counterparties: ReadonlyArray<FilterMultiSelectOption>;
}>;

type Props = Readonly<{
  triggerRef: RefObject<HTMLButtonElement | null>;
  values: TransactionsTableFilter;
  options: TransactionsFiltersOverlayOptions;
  onChange: (nextValues: TransactionsTableFilter) => void;
  onClose: () => void;
}>;

type SectionProps = Readonly<{
  testId: string;
  title: string;
  searchValue: string;
  options: ReadonlyArray<FilterMultiSelectOption>;
  selectedValues: ReadonlyArray<string>;
  onSearchChange: (value: string) => void;
  onToggleValue: (value: string) => void;
  autoFocus?: boolean;
}>;

const OVERLAY_OFFSET = 4;
const OVERLAY_VIEWPORT_GAP = 8;
const OVERLAY_MIN_WIDTH = 540;
const OVERLAY_MAX_WIDTH = 760;
const OVERLAY_MAX_HEIGHT = 520;

const EMPTY_SEARCH_STATE: SearchState = {
  accountIds: "",
  categories: "",
  kinds: "",
  currencies: "",
  counterparties: "",
};

const buildRect = (element: HTMLButtonElement): Rect => {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
};

const sortOptionsBySelection = (
  options: ReadonlyArray<FilterMultiSelectOption>,
  selectedSet: ReadonlySet<string>,
  query: string,
): ReadonlyArray<FilterMultiSelectOption> => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const sorted = [...options].sort((left, right) => left.label.localeCompare(right.label));
  const selected = sorted.filter((option) => selectedSet.has(option.value));
  const unselected = sorted.filter((option) => {
    if (selectedSet.has(option.value)) {
      return false;
    }
    return normalizedQuery.length === 0 || option.label.toLocaleLowerCase().includes(normalizedQuery);
  });

  return [...selected, ...unselected];
};

const getActiveFilterGroupCount = (values: TransactionsTableFilter): number =>
  [
    values.accountIds,
    values.categories,
    values.kinds,
    values.currencies,
    values.counterparties,
  ].filter((items) => items.length > 0).length;

const FilterSection = (props: SectionProps): ReactElement => {
  const {
    testId,
    title,
    searchValue,
    options,
    selectedValues,
    onSearchChange,
    onToggleValue,
    autoFocus,
  } = props;
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedSet = useMemo<ReadonlySet<string>>(
    () => new Set(selectedValues),
    [selectedValues],
  );
  const filteredOptions = useMemo<ReadonlyArray<FilterMultiSelectOption>>(
    () => sortOptionsBySelection(options, selectedSet, searchValue),
    [options, searchValue, selectedSet],
  );

  useEffect(() => {
    if (autoFocus && searchRef.current !== null) {
      searchRef.current.focus();
    }
  }, [autoFocus]);

  return (
    <section className={tableStyles.transactionsFiltersSection}>
      <div className={tableStyles.transactionsFiltersSectionTitle}>{title}</div>
      <input
        ref={searchRef}
        type="text"
        className={tableStyles.transactionsFiltersSectionSearch}
        placeholder={t("txn.filterSearchPlaceholder")}
        value={searchValue}
        onChange={(event) => onSearchChange(event.target.value)}
        data-testid={`${testId}-search`}
      />
      <div className={tableStyles.transactionsFiltersSectionOptions} data-testid={`${testId}-options`}>
        {filteredOptions.map((option) => (
          <label key={option.value} className={tableStyles.transactionsFiltersSectionOption}>
            <input
              type="checkbox"
              checked={selectedSet.has(option.value)}
              onChange={() => onToggleValue(option.value)}
            />
            <span className={tableStyles.transactionsFiltersSectionOptionLabel}>{option.label}</span>
          </label>
        ))}
        {filteredOptions.length === 0 && (
          <div className={tableStyles.filterPopoverEmpty}>{t("txn.filterNoMatches")}</div>
        )}
      </div>
    </section>
  );
};

export const TransactionsFiltersOverlay = (props: Props): ReactElement | null => {
  const { triggerRef, values, options, onChange, onClose } = props;
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(() =>
    triggerRef.current === null ? null : buildRect(triggerRef.current),
  );
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH_STATE);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (trigger === null) {
      onClose();
      return;
    }

    const updateRect = (): void => {
      setRect(buildRect(trigger));
    };

    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (overlayRef.current !== null && overlayRef.current.contains(target)) {
        return;
      }
      if (trigger.contains(target)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    updateRect();
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, triggerRef]);

  const overlayStyle = useMemo((): CSSProperties | null => {
    if (rect === null) {
      return null;
    }

    const width = Math.min(
      Math.max(rect.width + 280, OVERLAY_MIN_WIDTH),
      OVERLAY_MAX_WIDTH,
      window.innerWidth - OVERLAY_VIEWPORT_GAP * 2,
    );
    const maxLeft = window.innerWidth - width - OVERLAY_VIEWPORT_GAP;
    const left = Math.max(OVERLAY_VIEWPORT_GAP, Math.min(rect.left, maxLeft));
    const top = rect.top + rect.height + OVERLAY_OFFSET;

    return {
      top,
      left,
      width,
      maxHeight: Math.min(OVERLAY_MAX_HEIGHT, window.innerHeight - top - OVERLAY_VIEWPORT_GAP),
    };
  }, [rect]);

  const activeFilterGroupCount = getActiveFilterGroupCount(values);

  const handleReset = (): void => {
    onChange({
      ...values,
      accountIds: [],
      categories: [],
      kinds: [],
      currencies: [],
      counterparties: [],
    });
    setSearch(EMPTY_SEARCH_STATE);
  };

  const handleSearchChange = (key: FilterSectionKey, value: string): void => {
    setSearch((current) => ({ ...current, [key]: value }));
  };

  const handleToggleValue = (key: FilterSectionKey, value: string): void => {
    const selectedSet = new Set(values[key]);
    if (selectedSet.has(value)) {
      selectedSet.delete(value);
    } else {
      selectedSet.add(value);
    }

    const nextValues = [...selectedSet].sort((left, right) => {
      const leftLabel = options[key].find((option) => option.value === left)?.label ?? left;
      const rightLabel = options[key].find((option) => option.value === right)?.label ?? right;
      return leftLabel.localeCompare(rightLabel);
    });

    onChange({
      ...values,
      [key]: nextValues,
    });
  };

  if (overlayStyle === null) {
    return null;
  }

  return createPortal(
    <div
      ref={overlayRef}
      className={cn(tableStyles.filterPopover, tableStyles.transactionsFiltersOverlay)}
      style={overlayStyle}
      data-testid="transactions-filters-overlay"
    >
      <div className={tableStyles.transactionsFiltersOverlayHeader}>
        <div className={tableStyles.transactionsFiltersOverlayTitle}>{t("txn.filtersButton")}</div>
        <div className={tableStyles.transactionsFiltersOverlayActions}>
          <button
            type="button"
            className={tableStyles.transactionsFiltersOverlayAction}
            onClick={handleReset}
            disabled={activeFilterGroupCount === 0}
          >
            {t("txn.filtersReset")}
          </button>
          <button type="button" className={tableStyles.panelCloseButton} onClick={onClose}>
            &#x2715;
          </button>
        </div>
      </div>
      <div className={tableStyles.transactionsFiltersOverlayBody}>
        <FilterSection
          testId="transactions-filters-account"
          title={t("table.account")}
          searchValue={search.accountIds}
          options={options.accountIds}
          selectedValues={values.accountIds}
          onSearchChange={(value) => handleSearchChange("accountIds", value)}
          onToggleValue={(value) => handleToggleValue("accountIds", value)}
          autoFocus={true}
        />
        <FilterSection
          testId="transactions-filters-category"
          title={t("table.category")}
          searchValue={search.categories}
          options={options.categories}
          selectedValues={values.categories}
          onSearchChange={(value) => handleSearchChange("categories", value)}
          onToggleValue={(value) => handleToggleValue("categories", value)}
        />
        <FilterSection
          testId="transactions-filters-kind"
          title={t("table.kind")}
          searchValue={search.kinds}
          options={options.kinds}
          selectedValues={values.kinds}
          onSearchChange={(value) => handleSearchChange("kinds", value)}
          onToggleValue={(value) => handleToggleValue("kinds", value)}
        />
        <FilterSection
          testId="transactions-filters-currency"
          title={t("table.currency")}
          searchValue={search.currencies}
          options={options.currencies}
          selectedValues={values.currencies}
          onSearchChange={(value) => handleSearchChange("currencies", value)}
          onToggleValue={(value) => handleToggleValue("currencies", value)}
        />
        <FilterSection
          testId="transactions-filters-counterparty"
          title={t("table.counterparty")}
          searchValue={search.counterparties}
          options={options.counterparties}
          selectedValues={values.counterparties}
          onSearchChange={(value) => handleSearchChange("counterparties", value)}
          onToggleValue={(value) => handleToggleValue("counterparties", value)}
        />
      </div>
    </div>,
    document.body,
  );
};
