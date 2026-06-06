"use client";

import { type CSSProperties, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";

import type { FilterMultiSelectOption } from "@/ui/tables/shared/filterMultiSelectOption";
import panelStyles from "@/ui/tables/shared/TablePanel.module.css";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";
import type { TransactionsTableFilter } from "../editing/useEditableTransactionsTable";
import transactionStyles from "../TransactionsTable.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type FilterSectionKey = "accountIds" | "categories" | "kinds" | "currencies" | "counterparties";

type FilterSectionConfig = Readonly<{
  key: FilterSectionKey;
  testId: string;
  title: string;
  options: ReadonlyArray<FilterMultiSelectOption>;
  selectedValues: ReadonlyArray<string>;
}>;

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

type RowProps = Readonly<{
  title: string;
  testId: string;
  isOpen: boolean;
  selectedCount: number;
  onClick: () => void;
  rowRef: (element: HTMLButtonElement | null) => void;
}>;

type PickerProps = Readonly<{
  title: string;
  testId: string;
  search: string;
  options: ReadonlyArray<FilterMultiSelectOption>;
  selectedValues: ReadonlyArray<string>;
  onSearchChange: (value: string) => void;
  onToggleValue: (value: string) => void;
  pickerRef: RefObject<HTMLDivElement | null>;
}>;

const OVERLAY_OFFSET = 4;
const OVERLAY_VIEWPORT_GAP = 8;
const OVERLAY_MIN_WIDTH = 360;
const OVERLAY_MAX_WIDTH = 420;
const PICKER_OPTIONS_MAX_HEIGHT = 240;

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

const getOverlayStyle = (rect: Rect): CSSProperties => {
  const width = Math.min(
    Math.max(rect.width + 200, OVERLAY_MIN_WIDTH),
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
    maxHeight: window.innerHeight - top - OVERLAY_VIEWPORT_GAP,
  };
};

const FilterRow = (props: RowProps): ReactElement => {
  const { title, testId, isOpen, selectedCount, onClick, rowRef } = props;
  const { t } = useTranslation();
  const pickerId = `${testId}-picker`;

  return (
    <button
      ref={rowRef}
      type="button"
      className={cn(transactionStyles.transactionsFiltersRow, isOpen ? transactionStyles.transactionsFiltersRowOpen : "")}
      onClick={onClick}
      data-testid={`${testId}-row`}
      aria-expanded={isOpen}
      aria-controls={pickerId}
    >
      <span className={transactionStyles.transactionsFiltersRowTitle}>{title}</span>
      <span className={transactionStyles.transactionsFiltersRowSummary}>
        {selectedCount === 0 ? (
          <span className={transactionStyles.transactionsFiltersRowSummaryText}>{t("mode.all")}</span>
        ) : (
          <span className={transactionStyles.transactionsFiltersRowBadge} data-testid={`${testId}-badge`}>
            {selectedCount}
          </span>
        )}
        <span className={transactionStyles.transactionsFiltersRowCaret} aria-hidden="true">
          {isOpen ? "\u25B4" : "\u25BE"}
        </span>
      </span>
    </button>
  );
};

const FilterPicker = (props: PickerProps): ReactElement => {
  const {
    title,
    testId,
    search,
    options,
    selectedValues,
    onSearchChange,
    onToggleValue,
    pickerRef,
  } = props;
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (searchRef.current !== null) {
      searchRef.current.focus();
    }
  }, []);

  const selectedSet = useMemo<ReadonlySet<string>>(
    () => new Set(selectedValues),
    [selectedValues],
  );
  const filteredOptions = useMemo<ReadonlyArray<FilterMultiSelectOption>>(
    () => sortOptionsBySelection(options, selectedSet, search),
    [options, search, selectedSet],
  );

  return (
    <div
      ref={pickerRef}
      id={`${testId}-picker`}
      className={transactionStyles.transactionsFiltersPicker}
      data-testid={`${testId}-picker`}
    >
      <div className={transactionStyles.transactionsFiltersPickerTitle}>{title}</div>
      <input
        ref={searchRef}
        type="text"
        className={transactionStyles.transactionsFiltersPickerSearch}
        placeholder={t("txn.filterSearchPlaceholder")}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        data-testid={`${testId}-search`}
      />
      <div
        className={transactionStyles.transactionsFiltersPickerOptions}
        style={{ maxHeight: PICKER_OPTIONS_MAX_HEIGHT }}
        data-testid={`${testId}-options`}
      >
        {filteredOptions.map((option) => (
          <label key={option.value} className={transactionStyles.transactionsFiltersPickerOption}>
            <input
              type="checkbox"
              checked={selectedSet.has(option.value)}
              onChange={() => onToggleValue(option.value)}
            />
            <span className={transactionStyles.transactionsFiltersPickerOptionLabel}>{option.label}</span>
          </label>
        ))}
        {filteredOptions.length === 0 && (
          <div className={tableStyles.filterPopoverEmpty}>{t("txn.filterNoMatches")}</div>
        )}
      </div>
    </div>
  );
};

export const TransactionsFiltersOverlay = (props: Props): ReactElement | null => {
  const { triggerRef, values, options, onChange, onClose } = props;
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Partial<Record<FilterSectionKey, HTMLButtonElement | null>>>({});

  const [rect, setRect] = useState<Rect | null>(() =>
    triggerRef.current === null ? null : buildRect(triggerRef.current),
  );
  const [openSection, setOpenSection] = useState<FilterSectionKey | null>(null);
  const [search, setSearch] = useState<string>("");

  const sections = useMemo<ReadonlyArray<FilterSectionConfig>>(() => [
    {
      key: "accountIds",
      testId: "transactions-filters-account",
      title: t("table.account"),
      options: options.accountIds,
      selectedValues: values.accountIds,
    },
    {
      key: "categories",
      testId: "transactions-filters-category",
      title: t("table.category"),
      options: options.categories,
      selectedValues: values.categories,
    },
    {
      key: "kinds",
      testId: "transactions-filters-kind",
      title: t("table.kind"),
      options: options.kinds,
      selectedValues: values.kinds,
    },
    {
      key: "currencies",
      testId: "transactions-filters-currency",
      title: t("table.currency"),
      options: options.currencies,
      selectedValues: values.currencies,
    },
    {
      key: "counterparties",
      testId: "transactions-filters-counterparty",
      title: t("table.counterparty"),
      options: options.counterparties,
      selectedValues: values.counterparties,
    },
  ], [options, t, values.accountIds, values.categories, values.counterparties, values.currencies, values.kinds]);

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
        if (openSection === null) {
          return;
        }

        const insidePicker = pickerRef.current?.contains(target) ?? false;
        const insideAnyRow = Object.values(rowRefs.current).some((row) => row?.contains(target) ?? false);
        if (!insidePicker && !insideAnyRow) {
          setOpenSection(null);
          setSearch("");
        }
        return;
      }

      if (trigger.contains(target)) {
        return;
      }

      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      if (openSection !== null) {
        setOpenSection(null);
        setSearch("");
        return;
      }
      onClose();
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
  }, [onClose, openSection, triggerRef]);

  const overlayStyle = useMemo((): CSSProperties | null => {
    if (rect === null) {
      return null;
    }
    return getOverlayStyle(rect);
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
    setOpenSection(null);
    setSearch("");
  };

  const handleToggleSection = (key: FilterSectionKey): void => {
    if (openSection === key) {
      setOpenSection(null);
      setSearch("");
      return;
    }
    setOpenSection(key);
    setSearch("");
  };

  const handleToggleValue = (key: FilterSectionKey, value: string): void => {
    const selectedSet = new Set(values[key]);
    if (selectedSet.has(value)) {
      selectedSet.delete(value);
    } else {
      selectedSet.add(value);
    }

    const nextValues = [...selectedSet].sort((left, right) => {
      const sectionOptions = sections.find((section) => section.key === key)?.options ?? [];
      const leftLabel = sectionOptions.find((option) => option.value === left)?.label ?? left;
      const rightLabel = sectionOptions.find((option) => option.value === right)?.label ?? right;
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
      className={cn(tableStyles.filterPopover, transactionStyles.transactionsFiltersOverlay)}
      style={overlayStyle}
      data-testid="transactions-filters-overlay"
    >
      <div className={transactionStyles.transactionsFiltersOverlayHeader}>
        <div className={transactionStyles.transactionsFiltersOverlayTitle}>{t("txn.filtersButton")}</div>
        <div className={transactionStyles.transactionsFiltersOverlayActions}>
          <button
            type="button"
            className={transactionStyles.transactionsFiltersOverlayAction}
            onClick={handleReset}
            disabled={activeFilterGroupCount === 0}
          >
            {t("txn.filtersReset")}
          </button>
          <button type="button" className={panelStyles.panelCloseButton} onClick={onClose}>
            &#x2715;
          </button>
        </div>
      </div>
      <div className={transactionStyles.transactionsFiltersOverlayBody}>
        {sections.map((section) => (
          <div key={section.key} className={transactionStyles.transactionsFiltersOverlaySection}>
            <FilterRow
              title={section.title}
              testId={section.testId}
              isOpen={openSection === section.key}
              selectedCount={section.selectedValues.length}
              onClick={() => handleToggleSection(section.key)}
              rowRef={(element) => {
                rowRefs.current[section.key] = element;
              }}
            />
            {openSection === section.key && (
              <FilterPicker
                title={section.title}
                testId={section.testId}
                search={search}
                options={section.options}
                selectedValues={section.selectedValues}
                onSearchChange={setSearch}
                onToggleValue={(value) => handleToggleValue(section.key, value)}
                pickerRef={pickerRef}
              />
            )}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
};
