import { type ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { formatAmount } from "./format";

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
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current !== null) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = (): void => {
    setEditValue(String(currentValue));
    setEditing(true);
  };

  const commitEdit = (): void => {
    setEditing(false);
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
    }
  };

  if (editing) {
    return (
      <td className={`txn-cell txn-cell-right${maskClass}`}>
        <input
          ref={inputRef}
          className="drilldown-input"
          type="text"
          inputMode="decimal"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
        />
      </td>
    );
  }

  const isMasked = maskClass.length > 0;

  return (
    <td
      className={`txn-cell txn-cell-right${isMasked ? "" : " drilldown-editable"}${maskClass}`}
      onClick={isMasked ? undefined : startEditing}
    >
      {formatAmount(currentValue)}
    </td>
  );
};
