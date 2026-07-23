import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import type { NumberFormat } from "@/lib/locale";
import { useFormat } from "@/ui/FormatProvider";
import { postBudgetPlan, postBudgetPlanFill, fetchComment, postComment } from "@/ui/tables/budget/budgetTableApi";
import { formatAmount, isDecember } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import { parseMonetaryNumberEdit } from "@/ui/tables/shared/format";
import { useTableEditorActivation } from "@/ui/tables/shared/TableEditorActivationProvider";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";

const POPOVER_WIDTH = 240;
const POPOVER_VIEWPORT_MARGIN = 8;
const POPOVER_CELL_GAP = 4;

type PopoverPosition = Readonly<{
  top: number;
  left: number;
}>;

type PopoverSize = Readonly<{
  width: number;
  height: number;
}>;

type TextDirection = "ltr" | "rtl";

type RoundedBudgetInputsResult =
  | Readonly<{ ok: true; base: number; modifier: number }>
  | Readonly<{ ok: false; baseInvalid: boolean; modifierInvalid: boolean }>;

const parseRoundedBudgetInputs = (
  baseInput: string,
  modifierInput: string,
  originalBase: number,
  originalModifier: number,
  numberFormat: NumberFormat,
): RoundedBudgetInputsResult => {
  const base = parseMonetaryNumberEdit(baseInput, originalBase, numberFormat);
  const modifier = parseMonetaryNumberEdit(modifierInput, originalModifier, numberFormat);
  if (!base.ok || !modifier.ok) {
    return {
      ok: false,
      baseInvalid: !base.ok,
      modifierInvalid: !modifier.ok,
    };
  }
  return {
    ok: true,
    base: Math.round(base.value),
    modifier: Math.round(modifier.value),
  };
};

const getClampedCoordinate = (preferred: number, min: number, max: number): number => {
  const normalizedMax = Math.max(min, max);
  return Math.min(Math.max(preferred, min), normalizedMax);
};

const getViewportPopoverWidth = (viewportWidth: number): number => (
  Math.min(POPOVER_WIDTH, Math.max(1, viewportWidth - (POPOVER_VIEWPORT_MARGIN * 2)))
);

const getDocumentDirection = (): TextDirection => (
  document.documentElement.dir === "rtl" ? "rtl" : "ltr"
);

const getPreferredPopoverLeft = (cellRect: DOMRect, popoverWidth: number, textDirection: TextDirection): number => (
  textDirection === "rtl" ? cellRect.left : cellRect.right - popoverWidth
);

const getPopoverPosition = (
  cellRect: DOMRect,
  popoverSize: PopoverSize,
  viewportWidth: number,
  viewportHeight: number,
  textDirection: TextDirection,
): PopoverPosition => {
  const preferredLeft = getPreferredPopoverLeft(cellRect, popoverSize.width, textDirection);
  const left = getClampedCoordinate(
    preferredLeft,
    POPOVER_VIEWPORT_MARGIN,
    viewportWidth - popoverSize.width - POPOVER_VIEWPORT_MARGIN,
  );

  const belowTop = cellRect.bottom + POPOVER_CELL_GAP;
  const aboveTop = cellRect.top - popoverSize.height - POPOVER_CELL_GAP;
  const belowFits = belowTop + popoverSize.height <= viewportHeight - POPOVER_VIEWPORT_MARGIN;
  const aboveFits = aboveTop >= POPOVER_VIEWPORT_MARGIN;
  const preferredTop = belowFits || !aboveFits ? belowTop : aboveTop;
  const top = getClampedCoordinate(
    preferredTop,
    POPOVER_VIEWPORT_MARGIN,
    viewportHeight - popoverSize.height - POPOVER_VIEWPORT_MARGIN,
  );

  return {
    top: Math.round(top),
    left: Math.round(left),
  };
};

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

  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const editorId = `budget-plan:${month}:${direction}:${category}`;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const [modifierInput, setModifierInput] = useState<string>("");
  const [baseValidationError, setBaseValidationError] = useState<string | null>(null);
  const [modifierValidationError, setModifierValidationError] = useState<string | null>(null);
  const [commentInput, setCommentInput] = useState<string>("");
  const [isLoadingComment, setIsLoadingComment] = useState<boolean>(false);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({ top: 0, left: 0 });

  const cellRef = useRef<HTMLTableCellElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const adjustInputRef = useRef<HTMLInputElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);

  const originalBase = useRef<number>(0);
  const originalModifier = useRef<number>(0);
  const originalComment = useRef<string>("");

  const initializePopover = (): boolean => {
    const cell = cellRef.current;
    if (!showData || cell === null) return false;
    const roundedBase = Math.round(plannedBase);
    const roundedModifier = Math.round(plannedModifier);
    setBaseInput(String(roundedBase));
    setModifierInput(String(roundedModifier));
    setBaseValidationError(null);
    setModifierValidationError(null);
    originalBase.current = roundedBase;
    originalModifier.current = roundedModifier;

    const rect = cell.getBoundingClientRect();
    setPopoverPos(getPopoverPosition(
      rect,
      { width: getViewportPopoverWidth(window.innerWidth), height: 0 },
      window.innerWidth,
      window.innerHeight,
      getDocumentDirection(),
    ));
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
    return true;
  };
  const { requestActivation, releaseActivation } = useTableEditorActivation(
    editorId,
    initializePopover,
  );

  const openPopover = (): void => {
    requestActivation();
  };

  const updatePopoverPosition = useCallback((): void => {
    const cell = cellRef.current;
    const popover = popoverRef.current;
    if (cell === null || popover === null) return;

    const cellRect = cell.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const nextPosition = getPopoverPosition(
      cellRect,
      { width: popoverRect.width, height: popoverRect.height },
      window.innerWidth,
      window.innerHeight,
      getDocumentDirection(),
    );

    setPopoverPos((currentPosition) => (
      currentPosition.top === nextPosition.top && currentPosition.left === nextPosition.left
        ? currentPosition
        : nextPosition
    ));
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePopoverPosition();
  }, [isOpen, isLoadingComment, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handleViewportChange = (): void => {
      updatePopoverPosition();
    };

    const resizeObserver = new ResizeObserver(handleViewportChange);
    if (popoverRef.current !== null) {
      resizeObserver.observe(popoverRef.current);
    }

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (isOpen && adjustInputRef.current !== null) {
      adjustInputRef.current.focus();
      adjustInputRef.current.select();
    }
  }, [isOpen]);

  const reportInvalidInputs = useCallback((result: Extract<RoundedBudgetInputsResult, { ok: false }>): void => {
    const message = t("common.invalidNumber");
    const baseError = result.baseInvalid ? message : null;
    const modifierError = result.modifierInvalid ? message : null;
    setBaseValidationError(baseError);
    setModifierValidationError(modifierError);
    baseInputRef.current?.setCustomValidity(baseError ?? "");
    adjustInputRef.current?.setCustomValidity(modifierError ?? "");

    const firstInvalidInput = result.modifierInvalid ? adjustInputRef.current : baseInputRef.current;
    firstInvalidInput?.reportValidity();
  }, [t]);

  const saveChanges = useCallback((): boolean => {
    const parsedInputs = parseRoundedBudgetInputs(
      baseInput,
      modifierInput,
      originalBase.current,
      originalModifier.current,
      numberFormat,
    );
    if (!parsedInputs.ok) {
      reportInvalidInputs(parsedInputs);
      return false;
    }

    const baseChanged = parsedInputs.base !== originalBase.current;
    const modChanged = parsedInputs.modifier !== originalModifier.current;

    if (baseChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", parsedInputs.base);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: parsedInputs.base })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    if (modChanged) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", parsedInputs.modifier);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: parsedInputs.modifier })
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
    return true;
  }, [baseInput, modifierInput, commentInput, month, direction, category, numberFormat, onPlanSave, onCommentPresenceChange, onSyncStart, onSyncEnd, reportInvalidInputs]);

  const closePopover = useCallback((): void => {
    if (!isOpen) return;
    if (!saveChanges()) return;
    setIsOpen(false);
    releaseActivation();
  }, [isOpen, releaseActivation, saveChanges]);

  const handleFill = useCallback((): void => {
    const parsedInputs = parseRoundedBudgetInputs(
      baseInput,
      modifierInput,
      originalBase.current,
      originalModifier.current,
      numberFormat,
    );
    if (!parsedInputs.ok) {
      reportInvalidInputs(parsedInputs);
      return;
    }

    // Save base for current month if changed
    if (parsedInputs.base !== originalBase.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "base", parsedInputs.base);
      postBudgetPlan({ month, direction, category, kind: "base", plannedValue: parsedInputs.base })
        .catch((error) => {
          onPlanSave(month, direction, category, "base", originalBase.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Save modifier for current month if changed
    if (parsedInputs.modifier !== originalModifier.current) {
      onSyncStart();
      onPlanSave(month, direction, category, "modifier", parsedInputs.modifier);
      postBudgetPlan({ month, direction, category, kind: "modifier", plannedValue: parsedInputs.modifier })
        .catch((error) => {
          onPlanSave(month, direction, category, "modifier", originalModifier.current);
          console.error(error);
        })
        .finally(onSyncEnd);
    }

    // Fill base to following months
    onSyncStart();
    onFillMonths(month, direction, category, parsedInputs.base);
    postBudgetPlanFill({ fromMonth: month, direction, category, baseValue: parsedInputs.base })
      .catch((error) => {
        console.error(error);
      })
      .finally(onSyncEnd);

    setIsOpen(false);
    releaseActivation();
  }, [baseInput, modifierInput, month, direction, category, numberFormat, onPlanSave, onFillMonths, onSyncStart, onSyncEnd, releaseActivation, reportInvalidInputs]);

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
        releaseActivation();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, releaseActivation]);

  const handleBaseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const handleModifierKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") closePopover();
  };

  const parsedInputs = parseRoundedBudgetInputs(
    baseInput,
    modifierInput,
    originalBase.current,
    originalModifier.current,
    numberFormat,
  );
  const computedTotal = parsedInputs.ok ? parsedInputs.base + parsedInputs.modifier : 0;
  const canFill = !isDecember(month);

  const modifierIconClass = direction === "income"
    ? (plannedModifier > 0 ? styles.iconGood : styles.iconBad)
    : (plannedModifier > 0 ? styles.iconBadUp : styles.iconGoodDown);

  return (
    <td
      ref={cellRef}
      className={cn(styles.cell, styles.cellEditable, cmClass, maskClass, taintedClass, isPlanOver ? tableStateStyles.over : "")}
      data-testid={`budget-plan-cell-${editorId}`}
      onClick={isOpen ? undefined : openPopover}
    >
      {showData && plannedModifier !== 0 && (
        <span className={cn(styles.iconModifier, modifierIconClass)} />
      )}
      {formatAmount(planned, numberFormat)}
      {isOpen && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          style={{ top: popoverPos.top, left: popoverPos.left }}
        >
          <label className={styles.popoverField}>
            <span className={styles.popoverLabel}>{t("budget.popoverAdjust")}</span>
            <input
              ref={adjustInputRef}
              type="text"
              inputMode="decimal"
              className={styles.popoverInput}
              data-testid={`budget-plan-modifier-input-${editorId}`}
              value={modifierInput}
              aria-invalid={modifierValidationError !== null}
              onChange={(e) => {
                setModifierInput(e.target.value);
                setModifierValidationError(null);
                e.currentTarget.setCustomValidity("");
              }}
              onKeyDown={handleModifierKeyDown}
            />
          </label>
          <label className={styles.popoverField}>
            <span className={styles.popoverLabel}>{t("budget.popoverBase")}</span>
            <input
              ref={baseInputRef}
              type="text"
              inputMode="decimal"
              className={styles.popoverInput}
              data-testid={`budget-plan-base-input-${editorId}`}
              value={baseInput}
              aria-invalid={baseValidationError !== null}
              onChange={(e) => {
                setBaseInput(e.target.value);
                setBaseValidationError(null);
                e.currentTarget.setCustomValidity("");
              }}
              onKeyDown={handleBaseKeyDown}
            />
          </label>
          <div className={styles.popoverDivider} />
          <div className={styles.popoverTotal}>
            <span className={styles.popoverLabel}>{t("budget.popoverTotal")}</span>
            <span className={styles.popoverTotalValue}>{formatAmount(computedTotal, numberFormat)}</span>
          </div>
          {canFill && (
            <>
              <div className={styles.popoverDivider} />
              <button
                type="button"
                className={styles.popoverFillButton}
                onClick={handleFill}
              >
                {t("budget.popoverFill")}
              </button>
            </>
          )}
          <div className={styles.popoverDivider} />
          {isLoadingComment
            ? <span className={styles.popoverLoading}>{t("common.loading")}</span>
            : (
              <textarea
                className={styles.popoverComment}
                rows={3}
                placeholder={t("budget.popoverNote")}
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
