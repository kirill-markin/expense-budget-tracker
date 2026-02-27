import { type ReactElement, useRef, useState } from "react";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { CellSelectOverlay } from "./CellSelectOverlay";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

const KIND_OPTIONS: ReadonlyArray<string> = ["income", "spend", "transfer"];

type Props = Readonly<{
  entry: LedgerEntry;
  maskClass: string;
  onKindChange: (entryId: string, newKind: string, oldKind: string) => void;
}>;

export const EditableKind = (props: Props): ReactElement => {
  const { entry, maskClass, onKindChange } = props;

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
    if (value === null) return;
    if (value === entry.kind) return;
    onKindChange(entry.entryId, value, entry.kind);
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
      {entry.kind}
      {open && rect !== null && (
        <CellSelectOverlay
          options={KIND_OPTIONS}
          currentValue={entry.kind}
          allowEmpty={false}
          rect={rect}
          onSelect={handleSelect}
          onClose={handleClose}
        />
      )}
    </td>
  );
};
