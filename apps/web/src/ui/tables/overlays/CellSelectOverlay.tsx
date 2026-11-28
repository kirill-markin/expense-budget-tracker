import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCellOverlayPosition } from "./useCellOverlayPosition";
import { cn } from "@/lib/cn";

import type { FilterMultiSelectOption } from "@/ui/tables/shared/filterMultiSelectOption";
import styles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  options: ReadonlyArray<FilterMultiSelectOption>;
  currentValue: string | null;
  allowEmpty: boolean;
  rect: Rect;
  onSelect: (value: string | null) => void;
  onClose: () => void;
}>;

export const CellSelectOverlay = (props: Props): ReactElement => {
  const { options, currentValue, allowEmpty, rect, onSelect, onClose } = props;
  const { t, i18n } = useTranslation();

  const [search, setSearch] = useState<string>("");
  const [highlightIndex, setHighlightIndex] = useState<number>(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const position = useCellOverlayPosition(rect, 200, 260);

  const emptyLabel = allowEmpty ? t("table.selectNone") : null;
  const filtered = buildFiltered(options, emptyLabel, search, i18n.language);

  useEffect(() => {
    if (searchRef.current !== null) {
      searchRef.current.focus();
    }
  }, []);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent): void => {
      if (overlayRef.current !== null && !overlayRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filtered.length) {
        onSelect(filtered[highlightIndex].value);
      }
      return;
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearch(e.target.value);
    setHighlightIndex(-1);
  };

  const overlay = (
    <div
      ref={overlayRef}
      className={styles.selectOverlay}
      style={position ?? { top: rect.top, left: rect.left, minWidth: rect.width }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={searchRef}
        className={styles.selectSearch}
        type="text"
        value={search}
        placeholder={t("txn.filterSearchPlaceholder")}
        onChange={handleSearchChange}
        onKeyDown={handleKeyDown}
      />
      <div className={styles.selectOptions}>
        {filtered.map((item, i) => {
          const isActive = item.value === currentValue;
          const isHighlight = i === highlightIndex;
          return (
            <button
              key={item.key}
              className={cn(
                styles.selectOption,
                isActive ? styles.selectOptionActive : "",
                isHighlight ? styles.selectOptionHighlight : "",
              )}
              type="button"
              onMouseEnter={() => setHighlightIndex(i)}
              onClick={() => onSelect(item.value)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(overlay, document.body) as ReactElement;
};

type FilteredItem = Readonly<{ key: string; value: string | null; label: string }>;

const buildFiltered = (
  options: ReadonlyArray<FilterMultiSelectOption>,
  emptyLabel: string | null,
  search: string,
  locale: string,
): ReadonlyArray<FilteredItem> => {
  const query = search.toLocaleLowerCase(locale);
  const items: Array<FilteredItem> = [];

  if (emptyLabel !== null && emptyLabel.toLocaleLowerCase(locale).includes(query)) {
    items.push({ key: "empty", value: null, label: emptyLabel });
  }

  for (const option of options) {
    if (option.label.toLocaleLowerCase(locale).includes(query)
      || option.value.toLocaleLowerCase(locale).includes(query)) {
      items.push({ key: `option:${option.value}`, ...option });
    }
  }

  return items;
};
