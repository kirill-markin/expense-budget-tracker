import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  options: ReadonlyArray<string>;
  currentValue: string | null;
  allowEmpty: boolean;
  rect: Rect;
  onSelect: (value: string | null) => void;
  onClose: () => void;
}>;

export const CellSelectOverlay = (props: Props): ReactElement => {
  const { options, currentValue, allowEmpty, rect, onSelect, onClose } = props;

  const [search, setSearch] = useState<string>("");
  const [highlightIndex, setHighlightIndex] = useState<number>(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const filtered = buildFiltered(options, allowEmpty, search);

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
      className="cell-select-overlay"
      style={{ top: rect.top + rect.height, left: rect.left, minWidth: rect.width }}
    >
      <input
        ref={searchRef}
        className="cell-select-search"
        type="text"
        value={search}
        placeholder="Search..."
        onChange={handleSearchChange}
        onKeyDown={handleKeyDown}
      />
      <div className="cell-select-options">
        {filtered.map((item, i) => {
          const isActive = item.value === currentValue;
          const isHighlight = i === highlightIndex;
          let cls = "cell-select-option";
          if (isActive) cls += " cell-select-option-active";
          if (isHighlight) cls += " cell-select-option-highlight";
          return (
            <button
              key={item.key}
              className={cls}
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
  options: ReadonlyArray<string>,
  allowEmpty: boolean,
  search: string,
): ReadonlyArray<FilteredItem> => {
  const query = search.toLowerCase();
  const items: Array<FilteredItem> = [];

  if (allowEmpty) {
    const emptyLabel = "\u2014 (none)";
    if (query.length === 0 || emptyLabel.toLowerCase().includes(query) || "none".includes(query)) {
      items.push({ key: "__empty__", value: null, label: emptyLabel });
    }
  }

  for (const opt of options) {
    if (query.length === 0 || opt.toLowerCase().includes(query)) {
      items.push({ key: opt, value: opt, label: opt });
    }
  }

  return items;
};
