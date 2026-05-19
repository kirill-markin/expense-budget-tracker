import { type ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import { CellTextareaOverlay } from "@/ui/tables/overlays/CellTextareaOverlay";
import styles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entryId: string;
  currentValue: string | null;
  maskClass: string;
  onCommit: (entryId: string, newValue: string | null, oldValue: string | null) => void;
  cellClass: string;
  hints: ReadonlyArray<string>;
}>;

const NOTE_EDITOR_ROWS = 3;
const NOTE_MAX_LENGTH = 1000;

export const EditableNote = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onCommit, cellClass, hints } = props;

  const [editing, setEditing] = useState<boolean>(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);

  const startEditing = (): void => {
    if (cellRef.current === null) return;
    setRect(readElementRect(cellRef.current));
    setEditing(true);
  };

  const handleCommit = (newValue: string | null): void => {
    setEditing(false);
    setRect(null);
    if (newValue === currentValue) return;
    onCommit(entryId, newValue, currentValue);
  };

  const handleCancel = (): void => {
    setEditing(false);
    setRect(null);
  };

  const isMasked = maskClass.length > 0;

  useEffect(() => {
    if (!editing) return;

    const refreshPosition = (): void => {
      if (cellRef.current === null) return;
      const nextRect = readElementRect(cellRef.current);
      setRect((currentRect) => (
        currentRect !== null && areRectsEqual(currentRect, nextRect) ? currentRect : nextRect
      ));
    };

    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [editing]);

  return (
    <td
      ref={cellRef}
      className={cn(styles.cell, cellClass, !isMasked ? styles.editable : "", maskClass)}
      onClick={isMasked || editing ? undefined : startEditing}
    >
      <span className={styles.cellSingleLinePreview}>
        {currentValue === null || currentValue.length === 0 ? "\u2014" : currentValue}
      </span>
      {editing && rect !== null && (
        <CellTextareaOverlay
          currentValue={currentValue}
          rect={rect}
          hints={hints}
          rows={NOTE_EDITOR_ROWS}
          maxLength={NOTE_MAX_LENGTH}
          onCommit={handleCommit}
          onCancel={handleCancel}
        />
      )}
    </td>
  );
};

const readElementRect = (element: HTMLElement): Rect => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
};

const areRectsEqual = (left: Rect, right: Rect): boolean => {
  return (
    left.top === right.top
    && left.left === right.left
    && left.width === right.width
    && left.height === right.height
  );
};
