import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatAmount, isDecember } from "@/ui/tables/budgetTableLogic";
import { postBudgetPlan, postBudgetPlanFill, fetchComment, postComment } from "@/ui/tables/budgetTableApi";

const POPOVER_WIDTH = 240;

export type BudgetPlanCellProps = Readonly<{
  month: string;
  direction: string;
  category: string;
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  hasComment: boolean;
  showData: boolean;
  maskClass: string;
  taintedClass: string;
  isPlanOver: boolean;
  cmClass: string;
  onPlanSave: (month: string, direction: string, category: string, kind: "base" | "modifier", value: number) => void;
  onFillMonths: (sourceMonth: string, direction: string, category: string, baseValue: number) => void;
  onCommentPresenceChange: (month: string, direction: string, category: string, hasComment: boolean) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

export const BudgetPlanCell = (props: BudgetPlanCellProps): ReactElement => {
  const { month, direction, category, plannedBase, plannedModifier, planned, hasComment, showData, maskClass, taintedClass, isPlanOver, cmClass, onPlanSave, onFillMonths, onCommentPresenceChange, onSyncStart, onSyncEnd } = props;

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const [modifierInput, setModifierInput] = useState<string>("");
  const [commentInput, setCommentInput] = useState<string>("");
  const [isLoadingComment, setIsLoadingComment] = useState<boolean>(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const cellRef = useRef<HTMLTableCellElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const adjustInputRef = useRef<HTMLInputElement>(null);

  const originalBase = useRef<number>(0);
  const originalModifier = useRef<number>(0);
  const originalComment = useRef<string>("");

  const openPopover = (): void => {
    if (!showData) return;
    const roundedBase = Math.round(plannedBase);
    const roundedModifier = Math.round(plannedModifier);
    setBaseInput(String(roundedBase));
    setModifierInput(String(roundedModifier));
    originalBase.current = roundedBase;
    originalModifier.current = roundedModifier;

    const rect = cellRef.current?.getBoundingClientRect();
    if (rect !== undefined && rect !== null) {
      let left = rect.right - POPOVER_WIDTH;
      if (left < 0) left = rect.left;
      setPopoverPos({ top: rect.bottom + 4, left });
    }
    setIsOpen(true);

    setIsLoadingComment(true);
    setCommentInput("");
    originalComment.current = "";
    fetchComment(month, direction, category)
      .then((c) => {
        const val = c ?? "";
        setCommentInput(val);
        originalComment.current = val;
      })
      .catch((error) => console.error(error))
      .finally(() => setIsLoadingComment(false));
  };

  useEffect(() => {
    if (isOpen && adjustInputRef.current !== null) {
      adjustInputRef.current.focus();
      adjustInputRef.current.select();
    }
  }, [isOpen]);

  const saveChanges = useCallback((): void => {
    const newBase = Math.round(Number(baseInput));
    const newMod = Math.round(Number(modifierInput));

    const baseChanged = Number.isFinite(newBase) && newBase !== originalBase.current;
    const modChanged = Number.isFinite(newMod) && newMod !== originalModifier.current;

    if (baseChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", newBase);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: newBase })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    if (modChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", newMod);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: newMod })
        .catch((error) => {
          onPlanSave(month, direction, category, "modifier", originalModifier.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    if (commentInput !== originalComment.current) {
      onSyncStart();
      onCommentPresenceChange(month, direction, category, commentInput.trim().length > 0);
      postComment({ month, direction, category, comment: commentInput })
        .catch((error) => console.error(error))
        .finally(onSyncEnd);
    }
  }, [baseInput, modifierInput, commentInput, month, direction, category, onPlanSave, onCommentPresenceChange, onSyncStart, onSyncEnd]);

  const closePopover = useCallback((): void => {
    if (!isOpen) return;
    saveChanges();
    setIsOpen(false);
  }, [isOpen, saveChanges]);

  const handleFill = useCallback((): void => {
    const newBase = Math.round(Number(baseInput));
    if (!Number.isFinite(newBase)) return;

    // Save base for current month if changed
    if (newBase !== originalBase.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", newBase);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: newBase })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Save modifier for current month if changed
    const newMod = Math.round(Number(modifierInput));
    if (Number.isFinite(newMod) && newMod !== originalModifier.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", newMod);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: newMod })
        .catch((error) => {
          onPlanSave(month, direction, category, "modifier", originalModifier.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Fill base to following months
    onSyncStart();
    onFillMonths(month, direction, category, newBase);
    postBudgetPlanFill({ fromMonth: month, direction, category, baseValue: newBase })
      .catch((error) => {
        console.error(error);
      })
      .finally(onSyncEnd);

    setIsOpen(false);
  }, [baseInput, modifierInput, month, direction, category, onPlanSave, onFillMonths, onSyncStart, onSyncEnd]);

  // Click outside → close
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        popoverRef.current !== null && !popoverRef.current.contains(target) &&
        cellRef.current !== null && !cellRef.current.contains(target)
      ) {
        closePopover();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, closePopover]);

  // Escape → close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setIsOpen(false); // close without saving
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleBaseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const handleModifierKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const computedTotal = Math.round(Number(baseInput) || 0) + Math.round(Number(modifierInput) || 0);
  const canFill = !isDecember(month);

  const modifierIconClass = direction === "income"
    ? (plannedModifier > 0 ? "budget-icon-good" : "budget-icon-bad")
    : (plannedModifier > 0 ? "budget-icon-bad-up" : "budget-icon-good-down");

  return (
    <td
      ref={cellRef}
      className={`budget-cell budget-cell-editable${cmClass}${maskClass}${taintedClass}${isPlanOver ? " budget-over" : ""}`}
      onClick={isOpen ? undefined : openPopover}
    >
      {showData && plannedModifier !== 0 && (
        <span className={`budget-icon-modifier ${modifierIconClass}`} />
      )}
      {formatAmount(planned)}
      {isOpen && createPortal(
        <div
          ref={popoverRef}
          className="budget-popover"
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <label className="budget-popover-field">
            <span className="budget-popover-label">Adjust</span>
            <input
              ref={adjustInputRef}
              type="number"
              className="budget-popover-input"
              value={modifierInput}
              onChange={(e) => setModifierInput(e.target.value)}
              onKeyDown={handleModifierKeyDown}
            />
          </label>
          <label className="budget-popover-field">
            <span className="budget-popover-label">Base</span>
            <input
              type="number"
              className="budget-popover-input"
              value={baseInput}
              onChange={(e) => setBaseInput(e.target.value)}
              onKeyDown={handleBaseKeyDown}
            />
          </label>
          <div className="budget-popover-divider" />
          <div className="budget-popover-total">
            <span className="budget-popover-label">Total</span>
            <span className="budget-popover-total-value">{formatAmount(computedTotal)}</span>
          </div>
          {canFill && (
            <>
              <div className="budget-popover-divider" />
              <button
                type="button"
                className="budget-popover-fill-btn"
                onClick={handleFill}
              >
                Fill months &rarr;
              </button>
            </>
          )}
          <div className="budget-popover-divider" />
          {isLoadingComment
            ? <span className="budget-popover-loading">Loading&hellip;</span>
            : (
              <textarea
                className="budget-popover-comment"
                rows={2}
                placeholder="Note"
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
              />
            )
          }
        </div>,
        document.body,
      )}
    </td>
  );
};
