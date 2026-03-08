import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

import { CellComboOverlay } from "./CellComboOverlay";
import styles from "./TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entryId: string;
  currentValue: string | null;
  maskClass: string;
  onCommit: (entryId: string, newValue: string | null, oldValue: string | null) => void;
  cellClass?: string;
  hints?: ReadonlyArray<string>;
  allowEmptyString?: boolean;
}>;

export const EditableText = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onCommit, cellClass, hints, allowEmptyString } = props;
  const tdClass = cn(styles.cell, cellClass);

  const [editing, setEditing] = useState<boolean>(false);
  const [editValue, setEditValue] = useState<string>("");
  const [rect, setRect] = useState<Rect | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current !== null) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = (): void => {
    if (cellRef.current === null) return;
    const r = cellRef.current.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setEditValue(currentValue ?? "");
    setEditing(true);
  };

  const commitEdit = (): void => {
    setEditing(false);
    setRect(null);
    const trimmed = editValue.trim();
    const newValue = trimmed.length > 0 ? trimmed : (allowEmptyString ? "" : null);
    if (newValue === currentValue) return;
    onCommit(entryId, newValue, currentValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
      setRect(null);
    }
  };

  const handleComboCommit = (value: string | null): void => {
    setEditing(false);
    setRect(null);
    const nextValue = value === null && allowEmptyString ? "" : value;
    if (nextValue === currentValue) return;
    onCommit(entryId, nextValue, currentValue);
  };

  const handleComboClose = (): void => {
    setEditing(false);
    setRect(null);
  };

  const isMasked = maskClass.length > 0;
  const hasHints = hints !== undefined && hints.length > 0;

  return (
    <td
      ref={cellRef}
      className={cn(tdClass, !isMasked ? styles.editable : "", maskClass)}
      onClick={isMasked ? undefined : startEditing}
    >
      {currentValue === null || currentValue.length === 0 ? "\u2014" : currentValue}
      {editing && rect !== null && hasHints && (
        <CellComboOverlay
          hints={hints}
          currentValue={currentValue}
          rect={rect}
          onCommit={handleComboCommit}
          onClose={handleComboClose}
        />
      )}
      {editing && rect !== null && !hasHints && createPortal(
        <input
          ref={inputRef}
          className={styles.editorOverlay}
          type="text"
          value={editValue}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
        />,
        document.body,
      )}
    </td>
  );
};
