import { type ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

type Props = Readonly<{
  entryId: string;
  currentValue: string | null;
  maskClass: string;
  onCommit: (entryId: string, newValue: string | null, oldValue: string | null) => void;
  cellClass?: string;
}>;

export const EditableText = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onCommit, cellClass } = props;
  const tdClass = cellClass !== undefined ? `txn-cell ${cellClass}` : "txn-cell";

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
    setEditValue(currentValue ?? "");
    setEditing(true);
  };

  const commitEdit = (): void => {
    setEditing(false);
    const trimmed = editValue.trim();
    const newValue = trimmed.length > 0 ? trimmed : null;
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
    }
  };

  if (editing) {
    return (
      <td className={`${tdClass}${maskClass}`}>
        <input
          ref={inputRef}
          className="drilldown-input"
          type="text"
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
      className={`${tdClass}${isMasked ? "" : " drilldown-editable"}${maskClass}`}
      onClick={isMasked ? undefined : startEditing}
    >
      {currentValue ?? "\u2014"}
    </td>
  );
};
