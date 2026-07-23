import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

  const [editing, setEditing] = useState<boolean>(false);
  const [editValue, setEditValue] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);
  const editingRef = useRef<boolean>(false);

  useEffect(() => {
    if (editing && inputRef.current !== null) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const initializeEditing = (): boolean => {
    if (cellRef.current === null) return false;
    const r = cellRef.current.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    setEditValue(String(currentValue));
    setValidationError(null);
    editingRef.current = true;
    setEditing(true);
    return true;
  };
  const {
    requestActivation,
    releaseActivation,
    registerTransitionGate,
  } = useTableEditorActivation(editorId, initializeEditing);

  const startEditing = (): void => {
    requestActivation();
  };

  const commitEdit = useCallback((): boolean => {
    const parsed = parseMonetaryNumberEdit(editValue, currentValue, numberFormat);
    if (!parsed.ok) {
      const message = t("common.invalidNumber");
      setValidationError(message);
      if (inputRef.current !== null) {
        inputRef.current.setCustomValidity(message);
        inputRef.current.reportValidity();
      }
      return false;
    }

    editingRef.current = false;
    setEditing(false);
    setRect(null);
    releaseActivation();
    if (parsed.value !== currentValue) {
      onAmountCommit(entryId, parsed.value, currentValue);
    }
    return true;
  }, [currentValue, editValue, entryId, numberFormat, onAmountCommit, releaseActivation, t]);
  const commitEditRef = useRef<() => boolean>(commitEdit);
  useLayoutEffect((): void => {
    commitEditRef.current = commitEdit;
  }, [commitEdit]);

  useEffect(() => registerTransitionGate({
    isLifecycleUnresolved: (): boolean => editingRef.current,
    settleLifecycle: (): Promise<boolean> => Promise.resolve(commitEditRef.current()),
  }), [registerTransitionGate]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editingRef.current = false;
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
