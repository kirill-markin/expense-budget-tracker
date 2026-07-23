import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import type { NumberFormat } from "@/lib/locale";
import type { BudgetAdjustmentDirection } from "@/server/budget/budgetAdjustments";
import { useFormat } from "@/ui/FormatProvider";
import { BudgetAdjustmentEditor } from "@/ui/tables/budget/BudgetAdjustmentEditor";
import { isSuccessfulBudgetAdjustmentFlushOutcome } from "@/ui/tables/budget/budgetAdjustmentRecovery";
import { isValidBudgetAdjustmentCategory } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import { postBudgetPlan, postBudgetPlanFill } from "@/ui/tables/budget/budgetTableApi";
import { formatAmount, isDecember } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type { BudgetAdjustmentRowsController } from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";
import { parseMonetaryNumberEdit } from "@/ui/tables/shared/format";
import { useTableEditorActivation } from "@/ui/tables/shared/TableEditorActivationProvider";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";

const POPOVER_WIDTH = 720;
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

type RoundedBaseInputResult =
  | Readonly<{ ok: true; value: number }>
  | Readonly<{ ok: false }>;

const parseRoundedBaseInput = (
  input: string,
  originalValue: number,
  numberFormat: NumberFormat,
): RoundedBaseInputResult => {
  const parsed = parseMonetaryNumberEdit(input, originalValue, numberFormat);
  return parsed.ok ? { ok: true, value: Math.round(parsed.value) } : { ok: false };
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

const getPreferredPopoverLeft = (
  cellRect: DOMRect,
  popoverWidth: number,
  textDirection: TextDirection,
): number => (
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

const getAdjustmentDirection = (
  direction: string,
): BudgetAdjustmentDirection | null => (
  direction === "income" || direction === "spend" ? direction : null
);

export type BudgetPlanCellProps = Readonly<{
  month: string;
  direction: string;
  category: string;
  directionCategories: ReadonlyArray<string>;
  effectiveAllowlist: ReadonlySet<string> | null;
  currentMonth: string;
  plannedBase: number;
  plannedModifier: number;
  planned: number;
  showData: boolean;
  maskClass: string;
  taintedClass: string;
  isPlanOver: boolean;
  cmClass: string;
  budgetAdjustments: BudgetAdjustmentRowsController;
  onPlanSave: (
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ) => void;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

export const BudgetPlanCell = (props: BudgetPlanCellProps): ReactElement => {
  const {
    month,
    direction,
    category,
    directionCategories,
    effectiveAllowlist,
    currentMonth,
    plannedBase,
    plannedModifier,
    planned,
    showData,
    maskClass,
    taintedClass,
    isPlanOver,
    cmClass,
    budgetAdjustments,
    onPlanSave,
    onFillMonths,
    onSyncStart,
    onSyncEnd,
  } = props;

  const { numberFormat } = useFormat();
  const { t } = useTranslation();
  const editorId = `budget-plan:${month}:${direction}:${category}`;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const [baseValidationError, setBaseValidationError] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({ top: 0, left: 0 });

  const cellRef = useRef<HTMLTableCellElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const adjustmentInitialFocusRef = useRef<
    HTMLInputElement | HTMLButtonElement | null
  >(null);
  const originalBaseRef = useRef<number>(Math.round(plannedBase));
  const isOpenRef = useRef<boolean>(false);
  const interactedAdjustmentIdsRef = useRef<Set<string>>(new Set());
  const settleLifecycleRef = useRef<() => Promise<boolean>>(
    (): Promise<boolean> => Promise.resolve(true),
  );

  const adjustmentDirection = getAdjustmentDirection(direction);
  const adjustmentLocation = adjustmentDirection === null
    || !isValidBudgetAdjustmentCategory(category)
    ? null
    : { month, direction: adjustmentDirection, category };
  const adjustmentTotal = adjustmentLocation === null
    ? 0
    : budgetAdjustments.getCellTotal(adjustmentLocation, effectiveAllowlist);

  const setPopoverOpen = useCallback((open: boolean): void => {
    isOpenRef.current = open;
    setIsOpen(open);
  }, []);

  const setAdjustmentInitialFocusTarget = useCallback((
    target: HTMLInputElement | HTMLButtonElement | null,
  ): void => {
    adjustmentInitialFocusRef.current = target;
  }, []);

  const initializePopover = (): boolean => {
    const cell = cellRef.current;
    if (!showData || cell === null) return false;

    const roundedBase = Math.round(plannedBase);
    originalBaseRef.current = roundedBase;
    setBaseInput(String(roundedBase));
    setBaseValidationError(null);
    baseInputRef.current?.setCustomValidity("");
    adjustmentInitialFocusRef.current = null;
    interactedAdjustmentIdsRef.current = new Set();

    const rect = cell.getBoundingClientRect();
    setPopoverPos(getPopoverPosition(
      rect,
      { width: getViewportPopoverWidth(window.innerWidth), height: 0 },
      window.innerWidth,
      window.innerHeight,
      getDocumentDirection(),
    ));
    setPopoverOpen(true);
    return true;
  };
  const {
    requestActivation,
    prepareActivationRelease,
    cancelActivationRelease,
    cancelActivationRequest,
    releaseActivation,
    registerTransitionGate,
  } = useTableEditorActivation(editorId, initializePopover);

  const openPopover = (): void => {
    if (!showData || isOpenRef.current) return;
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
      currentPosition.top === nextPosition.top
        && currentPosition.left === nextPosition.left
        ? currentPosition
        : nextPosition
    ));
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePopoverPosition();
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;

    let animationFrameId: number | null = null;
    const schedulePositionUpdate = (): void => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame((): void => {
        animationFrameId = null;
        updatePopoverPosition();
      });
    };
    const resizeObserver = new ResizeObserver(schedulePositionUpdate);
    if (cellRef.current !== null) resizeObserver.observe(cellRef.current);
    if (popoverRef.current !== null) resizeObserver.observe(popoverRef.current);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);

    return () => {
      resizeObserver.disconnect();
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [isOpen, updatePopoverPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const focusTarget = adjustmentInitialFocusRef.current ?? baseInputRef.current;
    if (focusTarget === null) return;
    focusTarget.focus();
    if (focusTarget instanceof HTMLInputElement) focusTarget.select();
  }, [isOpen]);

  const parseAndReportBase = useCallback((): RoundedBaseInputResult => {
    const parsed = parseRoundedBaseInput(
      baseInput,
      originalBaseRef.current,
      numberFormat,
    );
    if (parsed.ok) {
      setBaseValidationError(null);
      baseInputRef.current?.setCustomValidity("");
      return parsed;
    }
    const message = t("common.invalidNumber");
    setBaseValidationError(message);
    baseInputRef.current?.setCustomValidity(message);
    baseInputRef.current?.reportValidity();
    return parsed;
  }, [baseInput, numberFormat, t]);

  const saveBase = useCallback((value: number): void => {
    if (value === originalBaseRef.current) return;
    const previousBase = originalBaseRef.current;
    originalBaseRef.current = value;
    onSyncStart();
    onPlanSave(month, direction, category, "base", value);
    void postBudgetPlan({
      month,
      direction,
      category,
      kind: "base",
      plannedValue: value,
    })
      .catch((error: unknown): void => {
        originalBaseRef.current = previousBase;
        onPlanSave(month, direction, category, "base", previousBase);
        logBudgetTableError(`save base for ${month}/${direction}/${category}`, error);
      })
      .finally(onSyncEnd);
  }, [
    category,
    direction,
    month,
    onPlanSave,
    onSyncEnd,
    onSyncStart,
  ]);

  const focusAdjustmentFlushFailure = useCallback((
    adjustmentIds: ReadonlyArray<string>,
  ): void => {
    window.requestAnimationFrame((): void => {
      const popover = popoverRef.current;
      if (popover === null) return;
      for (const adjustmentId of adjustmentIds) {
        const row = popover.querySelector<HTMLElement>(
          `[data-testid="budget-adjustment-row-${adjustmentId}"]`,
        );
        const target = row?.querySelector<HTMLElement>('[aria-invalid="true"]')
          ?? row?.querySelector<HTMLElement>("input, textarea, select, button");
        if (target !== undefined && target !== null) {
          target.focus();
          return;
        }
      }
    });
  }, []);

  const clearTrackedAdjustment = useCallback((adjustmentId: string): void => {
    interactedAdjustmentIdsRef.current.delete(adjustmentId);
  }, []);

  const flushInteractedAdjustments = useCallback(async (): Promise<boolean> => {
    const adjustmentIds = [...interactedAdjustmentIdsRef.current].filter(
      (adjustmentId): boolean => (
        budgetAdjustments.getRow(adjustmentId, effectiveAllowlist) !== null
      ),
    );
    interactedAdjustmentIdsRef.current = new Set(adjustmentIds);
    const failedAdjustmentIds = (await Promise.all(adjustmentIds.map(
      async (adjustmentId): Promise<string | null> => {
        try {
          const outcome = await budgetAdjustments.flushRow(adjustmentId);
          return isSuccessfulBudgetAdjustmentFlushOutcome(outcome)
            ? null
            : adjustmentId;
        } catch (error: unknown) {
          logBudgetTableError(
            `flush budget adjustment ${adjustmentId} on editor settlement`,
            error,
          );
          return adjustmentId;
        }
      },
    ))).filter((adjustmentId): adjustmentId is string => adjustmentId !== null);
    if (failedAdjustmentIds.length > 0) {
      focusAdjustmentFlushFailure(failedAdjustmentIds);
      return false;
    }
    interactedAdjustmentIdsRef.current = new Set();
    return true;
  }, [
    budgetAdjustments,
    effectiveAllowlist,
    focusAdjustmentFlushFailure,
  ]);

  const finishPopoverClose = useCallback((): void => {
    interactedAdjustmentIdsRef.current = new Set();
    setPopoverOpen(false);
    releaseActivation();
  }, [releaseActivation, setPopoverOpen]);

  const closePopover = useCallback(async (): Promise<boolean> => {
    if (!isOpenRef.current) return true;
    prepareActivationRelease();
    const parsedBase = parseAndReportBase();
    if (!parsedBase.ok) {
      cancelActivationRelease();
      return false;
    }
    saveBase(parsedBase.value);
    if (!await flushInteractedAdjustments()) {
      cancelActivationRelease();
      return false;
    }
    finishPopoverClose();
    return true;
  }, [
    cancelActivationRelease,
    finishPopoverClose,
    flushInteractedAdjustments,
    parseAndReportBase,
    prepareActivationRelease,
    saveBase,
  ]);

  const cancelBaseAndClosePopover = useCallback(async (): Promise<boolean> => {
    if (!isOpenRef.current) return true;
    prepareActivationRelease();
    const originalBase = String(originalBaseRef.current);
    setBaseInput(originalBase);
    setBaseValidationError(null);
    baseInputRef.current?.setCustomValidity("");
    if (!await flushInteractedAdjustments()) {
      cancelActivationRelease();
      return false;
    }
    finishPopoverClose();
    return true;
  }, [
    cancelActivationRelease,
    finishPopoverClose,
    flushInteractedAdjustments,
    prepareActivationRelease,
  ]);

  const restoreTriggerFocus = useCallback((): void => {
    window.requestAnimationFrame((): void => triggerButtonRef.current?.focus());
  }, []);

  const closePopoverAndRestoreFocus = useCallback(async (): Promise<void> => {
    if (await closePopover()) restoreTriggerFocus();
  }, [closePopover, restoreTriggerFocus]);

  const cancelBaseAndRestoreFocus = useCallback(async (): Promise<void> => {
    if (await cancelBaseAndClosePopover()) restoreTriggerFocus();
  }, [cancelBaseAndClosePopover, restoreTriggerFocus]);

  const handleFill = useCallback(async (): Promise<void> => {
    if (!isOpenRef.current) return;
    prepareActivationRelease();
    const parsedBase = parseAndReportBase();
    if (!parsedBase.ok) {
      cancelActivationRelease();
      return;
    }
    saveBase(parsedBase.value);
    if (!await flushInteractedAdjustments()) {
      cancelActivationRelease();
      return;
    }

    onSyncStart();
    onFillMonths(month, direction, category, parsedBase.value);
    void postBudgetPlanFill({
      fromMonth: month,
      direction,
      category,
      baseValue: parsedBase.value,
    })
      .catch((error: unknown): void => {
        logBudgetTableError(`fill base from ${month}/${direction}/${category}`, error);
      })
      .finally(onSyncEnd);

    finishPopoverClose();
    restoreTriggerFocus();
  }, [
    cancelActivationRelease,
    category,
    direction,
    finishPopoverClose,
    flushInteractedAdjustments,
    month,
    onFillMonths,
    onSyncEnd,
    onSyncStart,
    parseAndReportBase,
    prepareActivationRelease,
    restoreTriggerFocus,
    saveBase,
  ]);

  const settleLifecycle = useCallback(async (): Promise<boolean> => {
    if (isOpenRef.current) return closePopover();
    if (interactedAdjustmentIdsRef.current.size === 0) return true;
    return flushInteractedAdjustments();
  }, [closePopover, flushInteractedAdjustments]);
  settleLifecycleRef.current = settleLifecycle;

  useEffect(() => registerTransitionGate({
    isLifecycleUnresolved: (): boolean => (
      isOpenRef.current || interactedAdjustmentIdsRef.current.size > 0
    ),
    settleLifecycle: (): Promise<boolean> => settleLifecycleRef.current(),
  }), [registerTransitionGate]);

  useEffect(() => {
    if (showData) return;
    cancelActivationRequest();
    if (!isOpenRef.current) return;
    setPopoverOpen(false);
    releaseActivation();
    void flushInteractedAdjustments();
  }, [
    cancelActivationRequest,
    flushInteractedAdjustments,
    releaseActivation,
    setPopoverOpen,
    showData,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (
        target instanceof Element
        && target.closest('[data-table-editor-visibility-control="true"]') !== null
      ) {
        return;
      }
      if (
        popoverRef.current !== null
        && !popoverRef.current.contains(target)
        && cellRef.current !== null
        && !cellRef.current.contains(target)
      ) {
        void closePopover();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [closePopover, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (
        popoverRef.current?.querySelector(
          '[data-budget-adjustment-delete-dialog="true"]',
        ) !== null
      ) {
        return;
      }
      event.preventDefault();
      void cancelBaseAndRestoreFocus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [cancelBaseAndRestoreFocus, isOpen]);

  const parsedBase = parseRoundedBaseInput(
    baseInput,
    originalBaseRef.current,
    numberFormat,
  );
  const computedTotal = parsedBase.ok ? parsedBase.value + adjustmentTotal : 0;
  const canFill = !isDecember(month);
  const modifierIconClass = direction === "income"
    ? (plannedModifier > 0 ? styles.iconGood : styles.iconBad)
    : (plannedModifier > 0 ? styles.iconBadUp : styles.iconGoodDown);
  const formattedPlanned = showData ? formatAmount(planned, numberFormat) : "";
  const accessibleName = showData
    ? t("budget.openPlanEditor", {
      month,
      category,
      amount: formattedPlanned,
    })
    : "";

  return (
    <td
      ref={cellRef}
      className={cn(
        styles.cell,
        styles.cellEditable,
        cmClass,
        maskClass,
        taintedClass,
        isPlanOver ? tableStateStyles.over : "",
      )}
      data-testid={showData ? `budget-plan-cell-${editorId}` : undefined}
    >
      {showData && (
        <button
          ref={triggerButtonRef}
          type="button"
          className={styles.planCellButton}
          data-testid={`budget-plan-open-${editorId}`}
          aria-label={accessibleName}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          disabled={isOpen}
          onClick={openPopover}
        >
          {plannedModifier !== 0 && (
            <span className={cn(styles.iconModifier, modifierIconClass)} />
          )}
          {formattedPlanned}
        </button>
      )}
      {showData && isOpen && createPortal(
        <div
          ref={popoverRef}
          className={styles.popover}
          style={{ top: popoverPos.top, left: popoverPos.left }}
          data-testid={`budget-plan-popover-${editorId}`}
          role="dialog"
          aria-label={accessibleName}
        >
          {adjustmentLocation !== null && (
            <>
              <BudgetAdjustmentEditor
                editorId={editorId}
                location={adjustmentLocation}
                currentMonth={currentMonth}
                categories={directionCategories}
                effectiveAllowlist={effectiveAllowlist}
                controller={budgetAdjustments}
                onInitialFocusTargetChange={setAdjustmentInitialFocusTarget}
                onInteraction={(adjustmentId): void => {
                  interactedAdjustmentIdsRef.current.add(adjustmentId);
                }}
                onDeleteSuccess={clearTrackedAdjustment}
              />
              <div className={styles.popoverDivider} />
            </>
          )}
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
              onChange={(event) => {
                setBaseInput(event.target.value);
                setBaseValidationError(null);
                event.currentTarget.setCustomValidity("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void closePopoverAndRestoreFocus();
              }}
            />
          </label>
          <div className={styles.popoverDivider} />
          <div className={styles.popoverTotal}>
            <span className={styles.popoverLabel}>{t("budget.popoverTotal")}</span>
            <span className={styles.popoverTotalValue}>
              {formatAmount(computedTotal, numberFormat)}
            </span>
          </div>
          {canFill && (
            <>
              <div className={styles.popoverDivider} />
              <button
                type="button"
                className={styles.popoverFillButton}
                data-testid={`budget-plan-fill-${editorId}`}
                onClick={() => void handleFill()}
              >
                {t("budget.popoverFill")}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </td>
  );
};
