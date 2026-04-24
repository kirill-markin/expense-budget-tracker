"use client";

import { type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import filterStyles from "@/ui/FilterControls.module.css";

import type { FilterMultiSelectOption } from "@/ui/tables/shared/filterMultiSelectOption";
import tableStyles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  label: string;
  options: ReadonlyArray<FilterMultiSelectOption>;
  selectedValues: ReadonlyArray<string>;
  onChange: (nextValues: ReadonlyArray<string>) => void;
  testId: string;
}>;

const FILTER_POPOVER_MIN_WIDTH = 220;
const FILTER_POPOVER_MAX_WIDTH = 320;
const FILTER_POPOVER_OFFSET = 4;
const FILTER_POPOVER_VIEWPORT_GAP = 8;

export const FilterMultiSelect = (props: Props): ReactElement => {
  const { label, options, selectedValues, onChange, testId } = props;
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [open, setOpen] = useState<boolean>(false);

  const selectedSet = useMemo<ReadonlySet<string>>(
    () => new Set(selectedValues),
    [selectedValues],
  );

  const selectedLabels = useMemo<ReadonlyArray<string>>(
    () =>
      options
        .filter((option) => selectedSet.has(option.value))
        .map((option) => option.label)
        .sort((left, right) => left.localeCompare(right)),
    [options, selectedSet],
  );

  const summary = selectedLabels.length === 0
    ? t("mode.all")
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : t("txn.filterSelectedCount", { count: selectedLabels.length });

  const handleToggleOpen = (): void => {
    if (open) {
      setOpen(false);
      setRect(null);
      return;
    }

    if (triggerRef.current === null) {
      return;
    }

    const triggerRect = triggerRef.current.getBoundingClientRect();
    setRect({
      top: triggerRect.bottom + FILTER_POPOVER_OFFSET,
      left: triggerRect.left,
      width: triggerRect.width,
      height: triggerRect.height,
    });
    setOpen(true);
  };

  const handleClose = (): void => {
    setOpen(false);
    setRect(null);
  };

  const handleToggleValue = (value: string): void => {
    const next = new Set(selectedValues);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }

    onChange(
      [...next].sort((left, right) => {
        const leftLabel = options.find((option) => option.value === left)?.label ?? left;
        const rightLabel = options.find((option) => option.value === right)?.label ?? right;
        return leftLabel.localeCompare(rightLabel);
      }),
    );
  };

  return (
    <label className={filterStyles.filterLabel}>
      {label}
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          filterStyles.filterInput,
          filterStyles.filterTrigger,
          open ? filterStyles.filterTriggerOpen : "",
        )}
        onClick={handleToggleOpen}
        data-testid={testId}
      >
        <span className={filterStyles.filterTriggerText}>{summary}</span>
      </button>
      {open && rect !== null && createPortal(
        <FilterMultiSelectPopover
          testId={testId}
          rect={rect}
          options={options}
          selectedSet={selectedSet}
          onToggleValue={handleToggleValue}
          onClose={handleClose}
        />,
        document.body,
      )}
    </label>
  );
};

type PopoverProps = Readonly<{
  testId: string;
  rect: Rect;
  options: ReadonlyArray<FilterMultiSelectOption>;
  selectedSet: ReadonlySet<string>;
  onToggleValue: (value: string) => void;
  onClose: () => void;
}>;

const FilterMultiSelectPopover = (props: PopoverProps): ReactElement => {
  const { testId, rect, options, selectedSet, onToggleValue, onClose } = props;
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState<string>("");

  const filteredOptions = useMemo<ReadonlyArray<FilterMultiSelectOption>>(() => {
    const query = search.trim().toLocaleLowerCase();
    const sorted = [...options].sort((left, right) => left.label.localeCompare(right.label));
    const selected = sorted.filter((option) => selectedSet.has(option.value));
    const unselected = sorted.filter((option) => {
      if (selectedSet.has(option.value)) {
        return false;
      }
      return query.length === 0 || option.label.toLocaleLowerCase().includes(query);
    });
    return [...selected, ...unselected];
  }, [options, search, selectedSet]);

  const popoverStyle = useMemo((): CSSProperties => {
    const width = Math.min(Math.max(rect.width, FILTER_POPOVER_MIN_WIDTH), FILTER_POPOVER_MAX_WIDTH);
    const maxLeft = window.innerWidth - width - FILTER_POPOVER_VIEWPORT_GAP;
    const left = Math.max(FILTER_POPOVER_VIEWPORT_GAP, Math.min(rect.left, maxLeft));
    return {
      top: rect.top,
      left,
      width,
      maxHeight: Math.min(360, window.innerHeight - rect.top - FILTER_POPOVER_VIEWPORT_GAP),
    };
  }, [rect]);

  useEffect(() => {
    if (searchRef.current !== null) {
      searchRef.current.focus();
    }
  }, []);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current !== null && !popoverRef.current.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className={tableStyles.filterPopover}
      style={popoverStyle}
      data-testid={`${testId}-popover`}
    >
      <input
        ref={searchRef}
        type="text"
        className={tableStyles.filterPopoverSearch}
        placeholder={t("txn.filterSearchPlaceholder")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        data-testid={`${testId}-search`}
      />
      <div className={tableStyles.filterPopoverOptions}>
        {filteredOptions.map((option) => (
          <label key={option.value} className={tableStyles.filterPopoverOption}>
            <input
              type="checkbox"
              checked={selectedSet.has(option.value)}
              onChange={() => onToggleValue(option.value)}
            />
            <span className={tableStyles.filterPopoverOptionLabel}>{option.label}</span>
          </label>
        ))}
        {filteredOptions.length === 0 && (
          <div className={tableStyles.filterPopoverEmpty}>{t("txn.filterNoMatches")}</div>
        )}
      </div>
    </div>
  );
};
