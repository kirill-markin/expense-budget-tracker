import { type ReactElement, useRef, useState } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { CellSelectOverlay } from "./CellSelectOverlay";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entry: LedgerEntry;
  categories: ReadonlyArray<string>;
  maskClass: string;
  onCategoryChange: (entryId: string, newCategory: string | null, oldCategory: string | null) => void;
}>;

export const EditableCategory = (props: Props): ReactElement => {
  const { entry, categories, maskClass, onCategoryChange } = props;

  const [open, setOpen] = useState<boolean>(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);

  const isMasked = maskClass.length > 0;

  const handleClick = (): void => {
    if (cellRef.current === null) return;
    const r = cellRef.current.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setOpen(true);
  };

  const handleSelect = (value: string | null): void => {
    setOpen(false);
    setRect(null);
    if (value === entry.category) return;
    onCategoryChange(entry.entryId, value, entry.category);
  };

  const handleClose = (): void => {
    setOpen(false);
    setRect(null);
  };

  return (
    <td
      ref={cellRef}
      className={`txn-cell${isMasked ? "" : " drilldown-editable drilldown-editable-select"}${maskClass}`}
      onClick={isMasked ? undefined : handleClick}
    >
      {entry.category ?? "\u2014"}
      {open && rect !== null && (
        <CellSelectOverlay
          options={categories}
          currentValue={entry.category}
          allowEmpty={true}
          rect={rect}
          onSelect={handleSelect}
          onClose={handleClose}
        />
      )}
    </td>
  );
};
