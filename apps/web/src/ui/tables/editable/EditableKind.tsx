import { type ReactElement, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TRANSACTION_KIND_LABEL_VALUES, transactionKindLabel } from "@/i18n/transactionKindLabel";
import { cn } from "@/lib/cn";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { CellSelectOverlay } from "@/ui/tables/overlays/CellSelectOverlay";
import styles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entry: LedgerEntry;
  maskClass: string;
  onKindChange: (entryId: string, newKind: string, oldKind: string) => void;
}>;

export const EditableKind = (props: Props): ReactElement => {
  const { entry, maskClass, onKindChange } = props;
  const { t } = useTranslation();

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
      className={cn(styles.cell, !isMasked ? styles.editable : "", !isMasked ? styles.editableSelect : "", maskClass)}
      onClick={isMasked ? undefined : handleClick}
    >
      {transactionKindLabel(entry.kind, t)}
      {open && rect !== null && (
        <CellSelectOverlay
          options={TRANSACTION_KIND_LABEL_VALUES.map((kind) => ({ value: kind, label: transactionKindLabel(kind, t) }))}
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
