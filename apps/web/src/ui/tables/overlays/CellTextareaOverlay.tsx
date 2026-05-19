import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import styles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type OverlayPosition = Readonly<{ top: number; left: number; width: number; maxHeight: number }>;

type Props = Readonly<{
  currentValue: string | null;
  rect: Rect;
  hints: ReadonlyArray<string>;
  rows: number;
  maxLength: number;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}>;

const OVERLAY_GUTTER = 8;
const OVERLAY_MIN_WIDTH = 420;
const OVERLAY_MAX_WIDTH = 680;
const OVERLAY_MIN_HEIGHT = 180;

export const CellTextareaOverlay = (props: Props): ReactElement => {
  const { currentValue, rect, hints, rows, maxLength, onCommit, onCancel } = props;

  const [inputValue, setInputValue] = useState<string>(currentValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closedRef = useRef<boolean>(false);

  const filteredHints = filterHints(hints, inputValue);
  const position = resolveOverlayPosition(rect);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const selectionIndex = textarea.value.length;
    textarea.focus();
    textarea.setSelectionRange(selectionIndex, selectionIndex);
  }, []);

  const commit = useCallback((raw: string): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    const trimmed = raw.trim();
    onCommit(trimmed.length > 0 ? trimmed : null);
  }, [onCommit]);

  const cancel = useCallback((): void => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCancel();
  }, [onCancel]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent): void => {
      if (overlayRef.current !== null && !overlayRef.current.contains(e.target as Node)) {
        commit(inputValue);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [commit, inputValue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      cancel();
    }
  };

  const stopOverlayMouseEvent = (e: React.MouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
    const nextTarget = e.relatedTarget;
    if (isEventTargetInsideOverlay(overlayRef.current, nextTarget)) {
      return;
    }
    commit(inputValue);
  };

  const overlay = (
    <div
      ref={overlayRef}
      className={styles.textareaOverlay}
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
      onBlur={handleBlur}
      onMouseDown={stopOverlayMouseEvent}
      onClick={stopOverlayMouseEvent}
      onKeyDown={handleKeyDown}
    >
      <textarea
        ref={textareaRef}
        className={styles.textareaEditor}
        rows={rows}
        maxLength={maxLength}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
      />
      {filteredHints.length > 0 && (
        <div className={styles.textareaHints}>
          {filteredHints.map((hint) => (
            <button
              key={hint}
              className={cn(styles.textareaHint, hint === currentValue ? styles.textareaHintActive : "")}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(hint)}
            >
              {hint}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return createPortal(overlay, document.body) as ReactElement;
};

const resolveOverlayPosition = (rect: Rect): OverlayPosition => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableWidth = Math.max(0, viewportWidth - OVERLAY_GUTTER * 2);
  const preferredWidth = Math.max(rect.width, OVERLAY_MIN_WIDTH);
  const width = Math.min(preferredWidth, OVERLAY_MAX_WIDTH, availableWidth);
  const maxLeft = Math.max(OVERLAY_GUTTER, viewportWidth - width - OVERLAY_GUTTER);
  const left = Math.min(Math.max(rect.left, OVERLAY_GUTTER), maxLeft);
  const maxTop = Math.max(OVERLAY_GUTTER, viewportHeight - OVERLAY_MIN_HEIGHT - OVERLAY_GUTTER);
  const top = Math.min(Math.max(rect.top, OVERLAY_GUTTER), maxTop);
  const maxHeight = Math.max(OVERLAY_MIN_HEIGHT, viewportHeight - top - OVERLAY_GUTTER);
  return { top, left, width, maxHeight };
};

const filterHints = (
  hints: ReadonlyArray<string>,
  input: string,
): ReadonlyArray<string> => {
  const query = input.trim().toLowerCase();
  if (query.length === 0) return hints;
  return hints.filter((hint) => hint.toLowerCase().includes(query));
};

const isEventTargetInsideOverlay = (
  overlay: HTMLDivElement | null,
  target: EventTarget | null,
): boolean => {
  return overlay !== null && target instanceof Node && overlay.contains(target);
};
