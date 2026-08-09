import { type ReactElement } from "react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import type { BudgetAdjustmentDirection } from "@/server/budget/budgetAdjustments";
import { useFilteredMode } from "@/ui/FilteredModeProvider";
import { useFormat } from "@/ui/FormatProvider";
import { BudgetAdjustmentEditor } from "@/ui/tables/budget/BudgetAdjustmentEditor";
import {
  isSuccessfulBudgetAdjustmentFlushOutcome,
  recoverBudgetAdjustment,
} from "@/ui/tables/budget/budgetAdjustmentRecovery";
import { isValidBudgetAdjustmentCategory } from "@/ui/tables/budget/budgetAdjustmentRowsState";
import {
  consumeBudgetBaseLocalAcknowledgement,
  type BudgetBaseLocalAcknowledgement,
} from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import { postBudgetPlan, postBudgetPlanFill } from "@/ui/tables/budget/budgetTableApi";
import { formatAmount, isDecember } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type {
  BudgetAdjustmentCellLocation,
  BudgetAdjustmentRowsController,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import {
  createBudgetBaseEditorController,
  type BudgetBaseDraftSnapshot,
  type BudgetBaseEditorController,
  type BudgetBaseSettlementOutcome,
} from "@/ui/tables/budget/controller/budgetBaseEditorController";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";
import { parseMonetaryNumberEdit } from "@/ui/tables/shared/format";
import { useTableEditorActivation } from "@/ui/tables/shared/TableEditorActivationProvider";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";

const POPOVER_WIDTH = 720;
const POPOVER_VIEWPORT_MARGIN = 8;
const POPOVER_CELL_GAP = 4;
const BASE_AUTOSAVE_DELAY_MS = 600;

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

type PresentedBaseMutation = Readonly<{
  snapshot: BudgetBaseDraftSnapshot;
  mutationGeneration: number;
}>;

type PopoverCloseOutcome = "closed" | "transferred" | "retained";

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
  localBaseAcknowledgement: BudgetBaseLocalAcknowledgement | null;
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
    value: number,
  ) => void;
  onBaseMutationIssued: (
    month: string,
    direction: string,
    category: string,
  ) => number;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => number;
  onBaseAcknowledged: (
    month: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  onFillMonthsAcknowledged: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
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
    localBaseAcknowledgement,
    plannedModifier,
    planned,
    showData,
    maskClass,
    taintedClass,
    isPlanOver,
    cmClass,
    budgetAdjustments,
    onPlanSave,
    onBaseMutationIssued,
    onFillMonths,
    onBaseAcknowledged,
    onFillMonthsAcknowledged,
    onSyncStart,
    onSyncEnd,
  } = props;

  const { numberFormat } = useFormat();
  const { resumePendingModeTransition } = useFilteredMode();
  const { t } = useTranslation();
  const accessibilityId = useId();
  const editorId = `budget-plan:${month}:${direction}:${category}`;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [baseInput, setBaseInput] = useState<string>("");
  const [baseValidationError, setBaseValidationError] = useState<string | null>(null);
  const [baseSaveError, setBaseSaveError] = useState<string | null>(null);
  const [isPopoverActionPending, setIsPopoverActionPending] = useState<boolean>(false);
  const [shouldFocusBaseAfterAction, setShouldFocusBaseAfterAction] =
    useState<boolean>(false);
  const [shouldRestoreTriggerFocus, setShouldRestoreTriggerFocus] =
    useState<boolean>(false);
  const [popoverPos, setPopoverPos] = useState<PopoverPosition>({ top: 0, left: 0 });

  const cellRef = useRef<HTMLTableCellElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const baseInputRef = useRef<HTMLInputElement>(null);
  const isOpenRef = useRef<boolean>(false);
  const showDataRef = useRef<boolean>(showData);
  const previousShowDataRef = useRef<boolean>(showData);
  const baseInputValueRef = useRef<string>("");
  const persistBaseSnapshotRef = useRef<
    (snapshot: BudgetBaseDraftSnapshot) => Promise<void>
  >((_snapshot): Promise<void> => Promise.reject(
    new Error(`Budget Base persistence is not initialized for ${editorId}`),
  ));
  const baseControllerRef = useRef<BudgetBaseEditorController | null>(null);
  if (baseControllerRef.current === null) {
    baseControllerRef.current = createBudgetBaseEditorController(
      Math.round(plannedBase),
      (snapshot): Promise<void> => persistBaseSnapshotRef.current(snapshot),
    );
  }
  const baseController = baseControllerRef.current;
  const consumedLocalBaseAcknowledgementVersionRef = useRef<number>(0);
  const presentedBaseMutationRef = useRef<PresentedBaseMutation | null>(null);
  const handledBaseFailureRevisionRef = useRef<number | null>(null);
  const needsBaseSaveRecoveryRef = useRef<boolean>(false);
  const needsBaseValidationRecoveryRef = useRef<boolean>(false);
  const popoverActionPendingRef = useRef<boolean>(false);
  const activePopoverActionRef = useRef<Promise<boolean> | null>(null);
  const hiddenSettlementRef = useRef<Promise<boolean> | null>(null);
  const interactedAdjustmentAnchorByIdRef = useRef<
    Map<string, BudgetAdjustmentCellLocation>
  >(new Map());
  const settleLifecycleRef = useRef<() => Promise<boolean>>(
    (): Promise<boolean> => Promise.resolve(true),
  );
  showDataRef.current = showData;

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

  const persistBaseSnapshot = useCallback(async (
    snapshot: BudgetBaseDraftSnapshot,
  ): Promise<void> => {
    if (snapshot.value === null) {
      throw new Error(
        `Cannot persist invalid Base draft revision ${String(snapshot.revision)} for ${month}/${direction}/${category}`,
      );
    }
    const mutationGeneration = onBaseMutationIssued(
      month,
      direction,
      category,
    );
    presentedBaseMutationRef.current = { snapshot, mutationGeneration };
    onSyncStart();
    onPlanSave(month, direction, category, snapshot.value);
    try {
      await postBudgetPlan({
        month,
        direction,
        category,
        kind: "base",
        plannedValue: snapshot.value,
      });
      onBaseAcknowledged(
        month,
        direction,
        category,
        snapshot.value,
        mutationGeneration,
      );
    } catch (error: unknown) {
      logBudgetTableError(`save base for ${month}/${direction}/${category}`, error);
      throw error;
    } finally {
      onSyncEnd();
    }
  }, [
    category,
    direction,
    month,
    onBaseAcknowledged,
    onBaseMutationIssued,
    onPlanSave,
    onSyncEnd,
    onSyncStart,
  ]);
  persistBaseSnapshotRef.current = persistBaseSnapshot;

  const initializePopover = (): boolean => {
    const cell = cellRef.current;
    if (
      !showDataRef.current
      || cell === null
      || hiddenSettlementRef.current !== null
      || baseController.isPersistencePending()
    ) {
      return false;
    }

    const recoveringSave = needsBaseSaveRecoveryRef.current;
    const recoveringValidation = needsBaseValidationRecoveryRef.current;
    if (recoveringSave) {
      const acknowledgedBase = baseController.getAcknowledgement().value;
      baseInputValueRef.current = String(acknowledgedBase);
      setBaseInput(baseInputValueRef.current);
      setBaseValidationError(null);
      setBaseSaveError(t("budget.baseSaveFailed"));
      setShouldFocusBaseAfterAction(true);
    } else if (recoveringValidation) {
      setBaseInput(baseInputValueRef.current);
      setBaseValidationError(t("common.invalidNumber"));
      setBaseSaveError(null);
      setShouldFocusBaseAfterAction(true);
    } else {
      let roundedBase = Math.round(plannedBase);
      const consumed = consumeBudgetBaseLocalAcknowledgement(
        roundedBase,
        localBaseAcknowledgement,
        consumedLocalBaseAcknowledgementVersionRef.current,
      );
      roundedBase = consumed.value;
      consumedLocalBaseAcknowledgementVersionRef.current =
        consumed.version;
      baseController.synchronizeAcknowledgement(roundedBase);
      presentedBaseMutationRef.current = null;
      baseInputValueRef.current = String(roundedBase);
      setBaseInput(baseInputValueRef.current);
      setBaseValidationError(null);
      setBaseSaveError(null);
      setShouldFocusBaseAfterAction(false);
    }
    baseInputRef.current?.setCustomValidity("");

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
    registerRecoveryGate,
    registerTransitionGate,
  } = useTableEditorActivation(editorId, initializePopover);
  const retainAdjustmentCell = budgetAdjustments.retainCell;

  useEffect(() => {
    if (
      !isOpen
      || adjustmentDirection === null
      || !isValidBudgetAdjustmentCategory(category)
    ) {
      return;
    }
    return retainAdjustmentCell(editorId, {
      month,
      direction: adjustmentDirection,
      category,
    });
  }, [
    adjustmentDirection,
    category,
    editorId,
    isOpen,
    month,
    retainAdjustmentCell,
  ]);

  const openPopover = (): void => {
    if (!showDataRef.current || isOpenRef.current) return;
    const hiddenSettlement = hiddenSettlementRef.current;
    if (hiddenSettlement === null) {
      requestActivation();
      return;
    }
    void hiddenSettlement.then((): void => {
      if (!showDataRef.current || isOpenRef.current) return;
      requestActivation();
    });
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
    const input = baseInputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [isOpen]);

  useEffect(() => {
    if (
      !isOpen
      || !showData
      || !shouldFocusBaseAfterAction
      || isPopoverActionPending
    ) {
      return;
    }
    const animationFrameId = window.requestAnimationFrame((): void => {
      const input = baseInputRef.current;
      if (input === null) return;
      input.setCustomValidity(baseValidationError ?? "");
      input.focus();
      input.select();
      if (baseValidationError !== null) input.reportValidity();
      setShouldFocusBaseAfterAction(false);
    });
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [
    baseValidationError,
    isOpen,
    isPopoverActionPending,
    shouldFocusBaseAfterAction,
    showData,
  ]);

  useEffect(() => {
    if (isOpen || !shouldRestoreTriggerFocus || !showData) return;
    setShouldRestoreTriggerFocus(false);
    triggerButtonRef.current?.focus();
  }, [isOpen, shouldRestoreTriggerFocus, showData]);

  const validateCurrentBase = useCallback((): boolean => {
    const draft = baseController.getDraft();
    if (draft.value !== null) {
      setBaseValidationError(null);
      baseInputRef.current?.setCustomValidity("");
      return true;
    }
    needsBaseValidationRecoveryRef.current = true;
    const message = t("common.invalidNumber");
    setBaseValidationError(message);
    setShouldFocusBaseAfterAction(true);
    baseInputRef.current?.setCustomValidity(message);
    baseInputRef.current?.reportValidity();
    return false;
  }, [baseController, t]);

  const handleDefinitiveBaseFailure = useCallback((
    outcome: Extract<BudgetBaseSettlementOutcome, { status: "failed" }>,
  ): void => {
    if (handledBaseFailureRevisionRef.current === outcome.draft.revision) return;
    handledBaseFailureRevisionRef.current = outcome.draft.revision;
    const rolledBack = baseController.rollbackToAcknowledgement();
    if (rolledBack.value === null) {
      throw new Error(
        `Budget Base rollback produced an invalid draft for ${month}/${direction}/${category}`,
      );
    }
    baseInputValueRef.current = String(rolledBack.value);
    onPlanSave(month, direction, category, rolledBack.value);
    needsBaseSaveRecoveryRef.current = true;
    needsBaseValidationRecoveryRef.current = false;
    setBaseInput(baseInputValueRef.current);
    setBaseValidationError(null);
    baseInputRef.current?.setCustomValidity("");
    if (showDataRef.current) {
      setBaseSaveError(t("budget.baseSaveFailed"));
      setShouldFocusBaseAfterAction(true);
    } else {
      setBaseSaveError(null);
    }
  }, [
    baseController,
    category,
    direction,
    month,
    onPlanSave,
    t,
  ]);

  const settleCurrentBase = useCallback(async (): Promise<BudgetBaseSettlementOutcome> => {
    const outcome = await baseController.settleLatest();
    if (outcome.status === "failed") {
      handleDefinitiveBaseFailure(outcome);
    } else if (outcome.status === "settled") {
      const presentedMutation = presentedBaseMutationRef.current;
      if (
        presentedMutation !== null
        && presentedMutation.snapshot.value !== outcome.acknowledgement.value
      ) {
        onBaseAcknowledged(
          month,
          direction,
          category,
          outcome.acknowledgement.value,
          presentedMutation.mutationGeneration,
        );
        presentedBaseMutationRef.current = {
          snapshot: {
            revision: outcome.acknowledgement.revision,
            value: outcome.acknowledgement.value,
          },
          mutationGeneration: presentedMutation.mutationGeneration,
        };
      }
      needsBaseSaveRecoveryRef.current = false;
      needsBaseValidationRecoveryRef.current = false;
      handledBaseFailureRevisionRef.current = null;
      if (showDataRef.current) setBaseSaveError(null);
      void resumePendingModeTransition();
    }
    return outcome;
  }, [
    baseController,
    category,
    direction,
    handleDefinitiveBaseFailure,
    month,
    onBaseAcknowledged,
    resumePendingModeTransition,
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
    interactedAdjustmentAnchorByIdRef.current.delete(adjustmentId);
  }, []);

  const handleAdjustmentSettlementSuccess = useCallback((
    adjustmentId: string,
  ): void => {
    clearTrackedAdjustment(adjustmentId);
    void resumePendingModeTransition();
  }, [clearTrackedAdjustment, resumePendingModeTransition]);

  const flushInteractedAdjustments = useCallback(async (): Promise<boolean> => {
    const existingAdjustmentIds = new Set(
      budgetAdjustments.rows.map((row): string => row.adjustmentId),
    );
    const adjustmentIds = [
      ...interactedAdjustmentAnchorByIdRef.current.keys(),
    ].filter(
      (adjustmentId): boolean => existingAdjustmentIds.has(adjustmentId),
    );
    interactedAdjustmentAnchorByIdRef.current = new Map(
      [...interactedAdjustmentAnchorByIdRef.current].filter(
        ([adjustmentId]): boolean => existingAdjustmentIds.has(adjustmentId),
      ),
    );
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
      const failedAdjustmentIdSet = new Set(failedAdjustmentIds);
      interactedAdjustmentAnchorByIdRef.current = new Map(
        [...interactedAdjustmentAnchorByIdRef.current].filter(
          ([adjustmentId]): boolean => failedAdjustmentIdSet.has(adjustmentId),
        ),
      );
      focusAdjustmentFlushFailure(failedAdjustmentIds);
      return false;
    }
    interactedAdjustmentAnchorByIdRef.current = new Map();
    return true;
  }, [
    budgetAdjustments,
    focusAdjustmentFlushFailure,
  ]);

  const recoverTrackedAdjustment = useCallback(async (
    adjustmentId: string,
  ): Promise<void> => {
    const outcome = await recoverBudgetAdjustment(
      budgetAdjustments,
      adjustmentId,
    );
    if (outcome !== "recovered") {
      throw new Error(
        `Budget adjustment "${adjustmentId}" could not be recovered`,
      );
    }
    handleAdjustmentSettlementSuccess(adjustmentId);
  }, [budgetAdjustments, handleAdjustmentSettlementSuccess]);

  useEffect(() => registerRecoveryGate({
    ownsAdjustment: (adjustmentId): boolean =>
      interactedAdjustmentAnchorByIdRef.current.has(adjustmentId),
    recoverAdjustment: recoverTrackedAdjustment,
  }), [recoverTrackedAdjustment, registerRecoveryGate]);

  const finishPopoverClose = useCallback((): boolean => {
    interactedAdjustmentAnchorByIdRef.current = new Map();
    setPopoverOpen(false);
    return releaseActivation();
  }, [releaseActivation, setPopoverOpen]);

  const runExclusivePopoverAction = useCallback((
    action: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (activePopoverActionRef.current !== null) {
      return activePopoverActionRef.current;
    }
    popoverActionPendingRef.current = true;
    setIsPopoverActionPending(true);
    let request: Promise<boolean>;
    request = Promise.resolve()
      .then(action)
      .finally((): void => {
        if (activePopoverActionRef.current !== request) return;
        activePopoverActionRef.current = null;
        popoverActionPendingRef.current = false;
        setIsPopoverActionPending(false);
      });
    activePopoverActionRef.current = request;
    return request;
  }, []);

  const closePopover = useCallback(async (): Promise<PopoverCloseOutcome> => {
    if (!isOpenRef.current) return "closed";
    if (activePopoverActionRef.current !== null) return "retained";
    if (!validateCurrentBase()) return "retained";
    prepareActivationRelease();
    let activationReleased = false;
    let transferred = false;
    const settled = await runExclusivePopoverAction(async (): Promise<boolean> => {
      const baseOutcome = await settleCurrentBase();
      if (baseOutcome.status !== "settled") return false;
      if (!await flushInteractedAdjustments()) return false;
      transferred = finishPopoverClose();
      activationReleased = true;
      return true;
    });
    if (!activationReleased) cancelActivationRelease();
    if (!settled) return "retained";
    return transferred ? "transferred" : "closed";
  }, [
    cancelActivationRelease,
    finishPopoverClose,
    flushInteractedAdjustments,
    prepareActivationRelease,
    runExclusivePopoverAction,
    settleCurrentBase,
    validateCurrentBase,
  ]);

  const cancelBaseAndClosePopover = useCallback(async (): Promise<PopoverCloseOutcome> => {
    if (!isOpenRef.current) return "closed";
    if (activePopoverActionRef.current !== null) return "retained";
    prepareActivationRelease();
    let activationReleased = false;
    let transferred = false;
    const settled = await runExclusivePopoverAction(async (): Promise<boolean> => {
      const cancellationOutcome = await baseController.cancelDraft();
      if (cancellationOutcome.status === "failed") {
        handleDefinitiveBaseFailure({
          status: "failed",
          acknowledgement: cancellationOutcome.acknowledgement,
          draft: cancellationOutcome.draft,
          error: cancellationOutcome.error,
        });
        return false;
      }

      const rolledBack = cancellationOutcome.draft;
      if (rolledBack.value === null) {
        throw new Error(
          `Budget Base rollback produced an invalid draft for ${month}/${direction}/${category}`,
        );
      }
      baseInputValueRef.current = String(rolledBack.value);
      onPlanSave(month, direction, category, rolledBack.value);
      needsBaseSaveRecoveryRef.current = false;
      needsBaseValidationRecoveryRef.current = false;
      handledBaseFailureRevisionRef.current = null;
      setBaseInput(baseInputValueRef.current);
      setBaseValidationError(null);
      setBaseSaveError(null);
      baseInputRef.current?.setCustomValidity("");
      if (!await flushInteractedAdjustments()) return false;
      transferred = finishPopoverClose();
      activationReleased = true;
      void resumePendingModeTransition();
      return true;
    });
    if (!activationReleased) cancelActivationRelease();
    if (!settled) return "retained";
    return transferred ? "transferred" : "closed";
  }, [
    baseController,
    cancelActivationRelease,
    category,
    direction,
    finishPopoverClose,
    flushInteractedAdjustments,
    handleDefinitiveBaseFailure,
    month,
    onPlanSave,
    prepareActivationRelease,
    resumePendingModeTransition,
    runExclusivePopoverAction,
  ]);

  const closePopoverAndRestoreFocus = useCallback(async (): Promise<void> => {
    if (await closePopover() === "closed") setShouldRestoreTriggerFocus(true);
  }, [closePopover]);

  const cancelBaseAndRestoreFocus = useCallback(async (): Promise<void> => {
    if (await cancelBaseAndClosePopover() === "closed") {
      setShouldRestoreTriggerFocus(true);
    }
  }, [cancelBaseAndClosePopover]);

  const handleFill = useCallback(async (): Promise<void> => {
    if (!isOpenRef.current || activePopoverActionRef.current !== null) return;
    if (!validateCurrentBase()) return;
    prepareActivationRelease();
    let activationReleased = false;
    const settled = await runExclusivePopoverAction(async (): Promise<boolean> => {
      const baseOutcome = await settleCurrentBase();
      if (baseOutcome.status !== "settled") return false;
      if (!await flushInteractedAdjustments()) return false;
      const baseValue = baseOutcome.acknowledgement.value;
      const mutationGeneration = onFillMonths(
        month,
        direction,
        category,
        baseValue,
      );
      onSyncStart();
      void postBudgetPlanFill({
        fromMonth: month,
        direction,
        category,
        baseValue,
      })
        .then((): void => {
          onFillMonthsAcknowledged(
            month,
            direction,
            category,
            baseValue,
            mutationGeneration,
          );
        })
        .catch((error: unknown): void => {
          logBudgetTableError(`fill base from ${month}/${direction}/${category}`, error);
        })
        .finally(onSyncEnd);

      const transferred = finishPopoverClose();
      activationReleased = true;
      if (!transferred) setShouldRestoreTriggerFocus(true);
      return true;
    });
    if (!activationReleased) cancelActivationRelease();
    if (!settled && showDataRef.current) setShouldFocusBaseAfterAction(true);
  }, [
    cancelActivationRelease,
    category,
    direction,
    finishPopoverClose,
    flushInteractedAdjustments,
    month,
    onFillMonths,
    onFillMonthsAcknowledged,
    onSyncEnd,
    onSyncStart,
    prepareActivationRelease,
    runExclusivePopoverAction,
    settleCurrentBase,
    validateCurrentBase,
  ]);

  useEffect(() => {
    if (
      !isOpen
      || !showData
      || isPopoverActionPending
      || !baseController.isDirty()
      || baseController.getDraft().value === null
    ) {
      return;
    }
    const timer = window.setTimeout((): void => {
      void settleCurrentBase();
    }, BASE_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    baseController,
    baseInput,
    isOpen,
    isPopoverActionPending,
    settleCurrentBase,
    showData,
  ]);

  const settleLifecycle = useCallback(async (): Promise<boolean> => {
    const hiddenSettlement = hiddenSettlementRef.current;
    if (hiddenSettlement !== null) return hiddenSettlement;

    const activeAction = activePopoverActionRef.current;
    if (activeAction !== null && !await activeAction) return false;
    if (isOpenRef.current) return await closePopover() !== "retained";
    if (baseController.isDirty() || baseController.isPersistencePending()) {
      const baseOutcome = await settleCurrentBase();
      if (baseOutcome.status !== "settled") return false;
    }
    if (interactedAdjustmentAnchorByIdRef.current.size === 0) return true;
    return flushInteractedAdjustments();
  }, [
    baseController,
    closePopover,
    flushInteractedAdjustments,
    settleCurrentBase,
  ]);
  settleLifecycleRef.current = settleLifecycle;

  useEffect(() => registerTransitionGate({
    isLifecycleUnresolved: (): boolean => (
      isOpenRef.current
      || baseController.isDirty()
      || baseController.isPersistencePending()
      || activePopoverActionRef.current !== null
      || hiddenSettlementRef.current !== null
      || interactedAdjustmentAnchorByIdRef.current.size > 0
    ),
    settleLifecycle: (): Promise<boolean> => settleLifecycleRef.current(),
  }), [baseController, registerTransitionGate]);

  useLayoutEffect(() => {
    const previouslyShowedData = previousShowDataRef.current;
    previousShowDataRef.current = showData;
    if (showData) {
      if (
        !previouslyShowedData
        && hiddenSettlementRef.current === null
        && (
          needsBaseSaveRecoveryRef.current
          || needsBaseValidationRecoveryRef.current
          || interactedAdjustmentAnchorByIdRef.current.size > 0
        )
      ) {
        requestActivation();
      }
      return;
    }
    if (!previouslyShowedData) return;

    cancelActivationRequest();
    setShouldRestoreTriggerFocus(false);
    setShouldFocusBaseAfterAction(false);
    setBaseValidationError(null);
    setBaseSaveError(null);
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement
      && (
        popoverRef.current?.contains(activeElement) === true
        || cellRef.current?.contains(activeElement) === true
      )
    ) {
      activeElement.blur();
    }

    const wasOpen = isOpenRef.current;
    if (!wasOpen && activePopoverActionRef.current === null) return;
    if (activePopoverActionRef.current === null) prepareActivationRelease();
    setPopoverOpen(false);
    let hiddenSettlement: Promise<boolean>;
    hiddenSettlement = Promise.resolve()
      .then(async (): Promise<boolean> => {
        const activeAction = activePopoverActionRef.current;
        if (activeAction !== null) return activeAction;
        return runExclusivePopoverAction(async (): Promise<boolean> => {
          const baseOutcome = await settleCurrentBase();
          if (baseOutcome.status !== "settled") return false;
          if (!await flushInteractedAdjustments()) return false;
          interactedAdjustmentAnchorByIdRef.current = new Map();
          return true;
        });
      })
      .finally((): void => {
        releaseActivation();
        if (hiddenSettlementRef.current === hiddenSettlement) {
          hiddenSettlementRef.current = null;
        }
        if (
          showDataRef.current
          && (
            needsBaseSaveRecoveryRef.current
            || needsBaseValidationRecoveryRef.current
            || interactedAdjustmentAnchorByIdRef.current.size > 0
          )
          && !isOpenRef.current
        ) {
          requestActivation();
        }
      });
    hiddenSettlementRef.current = hiddenSettlement;
  }, [
    cancelActivationRequest,
    flushInteractedAdjustments,
    prepareActivationRelease,
    releaseActivation,
    requestActivation,
    runExclusivePopoverAction,
    settleCurrentBase,
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
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        popoverRef.current?.contains(target) === true
        || cellRef.current?.contains(target) === true
      ) {
        return;
      }
      void closePopover();
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [closePopover, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || popoverActionPendingRef.current) return;
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
    baseController.getAcknowledgement().value,
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
  const baseError = baseSaveError ?? baseValidationError;

  return (
    <td
      ref={cellRef}
      className={cn(
        styles.cell,
        showData ? styles.cellEditable : "",
        cmClass,
        maskClass,
        showData ? taintedClass : "",
        showData && isPlanOver ? tableStateStyles.over : "",
      )}
      data-testid={showData ? `budget-plan-cell-${editorId}` : undefined}
    >
      {!showData && MASKED_CELL_PLACEHOLDER}
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
          aria-busy={isPopoverActionPending}
          inert={isPopoverActionPending}
          role="dialog"
          aria-label={accessibleName}
        >
          <label className={styles.popoverField}>
            <span className={styles.popoverLabel}>{t("budget.popoverBase")}</span>
            <input
              ref={baseInputRef}
              type="text"
              inputMode="decimal"
              className={styles.popoverInput}
              data-testid={`budget-plan-base-input-${editorId}`}
              value={baseInput}
              aria-invalid={baseError !== null}
              aria-describedby={baseError === null
                ? undefined
                : `${accessibilityId}-base-error`}
              disabled={isPopoverActionPending}
              onChange={(event) => {
                const nextInput = event.target.value;
                const parsed = parseRoundedBaseInput(
                  nextInput,
                  baseController.getAcknowledgement().value,
                  numberFormat,
                );
                baseInputValueRef.current = nextInput;
                baseController.updateDraft(parsed.ok ? parsed.value : null);
                needsBaseSaveRecoveryRef.current = false;
                needsBaseValidationRecoveryRef.current = !parsed.ok;
                handledBaseFailureRevisionRef.current = null;
                setBaseInput(nextInput);
                setBaseValidationError(null);
                setBaseSaveError(null);
                event.currentTarget.setCustomValidity("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                void closePopoverAndRestoreFocus();
              }}
            />
          </label>
          {baseError !== null && (
            <span
              id={`${accessibilityId}-base-error`}
              className={styles.adjustmentError}
              data-testid={`budget-plan-base-error-${editorId}`}
              role="alert"
            >
              {baseError}
            </span>
          )}
          {canFill && (
            <>
              <div className={styles.popoverDivider} />
              <button
                type="button"
                className={styles.popoverFillButton}
                data-testid={`budget-plan-fill-${editorId}`}
                disabled={isPopoverActionPending}
                onClick={() => void handleFill()}
              >
                {t("budget.popoverFill")}
              </button>
            </>
          )}
          {adjustmentLocation !== null && (
            <>
              <div className={styles.popoverDivider} />
              <BudgetAdjustmentEditor
                editorId={editorId}
                location={adjustmentLocation}
                currentMonth={currentMonth}
                categories={directionCategories}
                effectiveAllowlist={effectiveAllowlist}
                editorAnchorByAdjustmentId={
                  interactedAdjustmentAnchorByIdRef.current
                }
                controller={budgetAdjustments}
                onInteraction={(adjustmentId): void => {
                  interactedAdjustmentAnchorByIdRef.current.set(
                    adjustmentId,
                    adjustmentLocation,
                  );
                }}
                onDeleteSuccess={handleAdjustmentSettlementSuccess}
                onSettlementSuccess={handleAdjustmentSettlementSuccess}
              />
            </>
          )}
          <div className={styles.popoverDivider} />
          <div className={styles.popoverTotal}>
            <span className={styles.popoverLabel}>{t("budget.popoverTotal")}</span>
            <span className={styles.popoverTotalValue}>
              {formatAmount(computedTotal, numberFormat)}
            </span>
          </div>
        </div>,
        document.body,
      )}
    </td>
  );
};
