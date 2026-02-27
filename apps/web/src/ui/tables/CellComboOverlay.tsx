import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  hints: ReadonlyArray<string>;
  currentValue: string | null;
  rect: Rect;
  onCommit: (value: string | null) => void;
  onClose: () => void;
}>;

export const CellComboOverlay = (props: Props): ReactElement => {
  const { hints, currentValue, rect, onCommit, onClose } = props;

  const [inputValue, setInputValue] = useState<string>(currentValue ?? "");
  const [highlightIndex, setHighlightIndex] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const filtered = filterHints(hints, inputValue);

  useEffect(() => {
    if (inputRef.current !== null) {
      inputRef.current.focus();
      inputRef.current.select();
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

  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    onCommit(trimmed.length > 0 ? trimmed : null);
  };

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
        commit(filtered[highlightIndex]);
      } else {
        commit(inputValue);
      }
      return;
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setInputValue(e.target.value);
    setHighlightIndex(-1);
  };

  const overlay = (
    <div
      ref={overlayRef}
      className="cell-select-overlay"
      style={{ top: rect.top + rect.height, left: rect.left, minWidth: rect.width }}
    >
      <input
        ref={inputRef}
        className="cell-select-search"
        type="text"
        value={inputValue}
        placeholder="Type or select..."
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
      />
      <div className="cell-select-options">
        {filtered.map((hint, i) => {
          const isActive = hint === currentValue;
          const isHighlight = i === highlightIndex;
          let cls = "cell-select-option";
          if (isActive) cls += " cell-select-option-active";
          if (isHighlight) cls += " cell-select-option-highlight";
          return (
            <button
              key={hint}
              className={cls}
              type="button"
              onMouseEnter={() => setHighlightIndex(i)}
              onClick={() => commit(hint)}
            >
              {hint}
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(overlay, document.body) as ReactElement;
};

const filterHints = (
  hints: ReadonlyArray<string>,
  input: string,
): ReadonlyArray<string> => {
  const query = input.toLowerCase();
  if (query.length === 0) return hints;
  return hints.filter((h) => h.toLowerCase().includes(query));
};
