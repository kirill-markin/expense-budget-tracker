import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { useFormat } from "@/ui/FormatProvider";

import { formatAmount, parseMonetaryNumberEdit } from "@/ui/tables/shared/format";
import { useTableEditorActivation } from "@/ui/tables/shared/TableEditorActivationProvider";
import styles from "@/ui/tables/shared/TableUi.module.css";

type Rect = Readonly<{ top: number; left: number; width: number; height: number }>;

type Props = Readonly<{
  entryId: string;
  currentValue: number;
  maskClass: string;
  onAmountCommit: (entryId: string, newAmount: number, oldAmount: number) => void;
}>;

export const EditableAmount = (props: Props): ReactElement => {
  const { entryId, currentValue, maskClass, onAmountCommit } = props;
  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const editorId = `transaction-amount:${entryId}`;
  const { requestActivation, releaseActivation } = useTableEditorActivation(editorId);

  const [editing, setEditing] = useState<boolean>(false);
  const [editValue, setEditValue] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);
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
    if (!requestActivation()) return;
    const r = cellRef.current.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setEditValue(String(currentValue));
    setValidationError(null);
    setEditing(true);
  };

  const commitEdit = (): void => {
    const parsed = parseMonetaryNumberEdit(editValue, currentValue, numberFormat);
    if (!parsed.ok) {
      const message = t("common.invalidNumber");
      setValidationError(message);
      if (inputRef.current !== null) {
        inputRef.current.setCustomValidity(message);
        inputRef.current.reportValidity();
      }
      return;
    }

    setEditing(false);
    setRect(null);
    releaseActivation();
    if (parsed.value === currentValue) return;
    onAmountCommit(entryId, parsed.value, currentValue);
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
      releaseActivation();
    }
  };

  const isMasked = maskClass.length > 0;

  return (
    <td
      ref={cellRef}
      className={cn(styles.cell, styles.cellRight, !isMasked ? styles.editable : "", maskClass)}
      data-testid={`transaction-amount-${entryId}`}
      onClick={isMasked ? undefined : startEditing}
    >
      {formatAmount(currentValue, numberFormat)}
      {editing && rect !== null && createPortal(
        <input
          ref={inputRef}
          className={styles.editorOverlay}
          type="text"
          inputMode="decimal"
          data-testid={`transaction-amount-input-${entryId}`}
          aria-invalid={validationError !== null}
          aria-label={t("table.amount")}
          value={editValue}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height, textAlign: "right" }}
          onChange={(e) => {
            setEditValue(e.target.value);
            setValidationError(null);
            e.currentTarget.setCustomValidity("");
          }}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
        />,
        document.body,
      )}
    </td>
  );
};
