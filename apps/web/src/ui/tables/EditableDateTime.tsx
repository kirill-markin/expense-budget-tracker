import { type ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { formatDateTime } from "./format";

type Props = Readonly<{
  entryId: string;
  currentValue: string;
  maskClass: string;
  onDateTimeCommit: (entryId: string, newTs: string, oldTs: string) => void;
}>;

const toDatetimeLocalValue = (isoString: string): string => {
  const date = new Date(isoString);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
};

const fromDatetimeLocalValue = (localValue: string): string => {
  return new Date(localValue).toISOString();
};

export const EditableDateTime = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onDateTimeCommit } = props;

  const [editing, setEditing] = useState<boolean>(false);
  const [editValue, setEditValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing && inputRef.current !== null) {
      inputRef.current.focus();
    }
  }, [editing]);

  const startEditing = (): void => {
    setEditValue(toDatetimeLocalValue(currentValue));
    setEditing(true);
  };

  const commitEdit = (): void => {
    setEditing(false);
    if (editValue.length === 0) return;
    const newTs = fromDatetimeLocalValue(editValue);
    if (newTs === currentValue) return;
    onDateTimeCommit(entryId, newTs, currentValue);
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
      <td className={`txn-cell txn-cell-mono${maskClass}`}>
        <input
          ref={inputRef}
          className="drilldown-input"
          type="datetime-local"
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
      className={`txn-cell txn-cell-mono${isMasked ? "" : " drilldown-editable"}${maskClass}`}
      onClick={isMasked ? undefined : startEditing}
    >
      {formatDateTime(currentValue)}
    </td>
  );
};
