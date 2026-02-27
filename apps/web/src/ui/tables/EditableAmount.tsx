import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

import { formatAmount } from "./format";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entryId: string;
  currentValue: number;
  maskClass: string;
  onAmountCommit: (entryId: string, newAmount: number, oldAmount: number) => void;
}>;

export const EditableAmount = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onAmountCommit } = props;

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
    setEditValue(String(currentValue));
    setEditing(true);
  };

  const commitEdit = (): void => {
    setEditing(false);
    setRect(null);
    const parsed = parseFloat(editValue.trim());
    if (!Number.isFinite(parsed)) return;
    if (parsed === currentValue) return;
    onAmountCommit(entryId, parsed, currentValue);
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

  const isMasked = maskClass.length > 0;

  return (
    <td
      ref={cellRef}
      className={`txn-cell txn-cell-right${isMasked ? "" : " drilldown-editable"}${maskClass}`}
      onClick={isMasked ? undefined : startEditing}
    >
      {formatAmount(currentValue)}
      {editing && rect !== null && createPortal(
        <input
          ref={inputRef}
          className="cell-editor-overlay"
          type="text"
          inputMode="decimal"
          value={editValue}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, textAlign: "right" }}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
        />,
        document.body,
      )}
    </td>
  );
};
