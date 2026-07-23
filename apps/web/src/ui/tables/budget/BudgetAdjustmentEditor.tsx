"use client";

import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { offsetMonth } from "@/lib/monthUtils";
import {
  getBudgetAdjustmentCategoryOptions,
  isValidBudgetAdjustmentNoteInput,
  parseBudgetAdjustmentAmount,
  parseBudgetAdjustmentDraft,
  type BudgetAdjustmentDraftError,
  type BudgetAdjustmentEditorRow,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";
import {
  isSuccessfulBudgetAdjustmentFlushOutcome,
  recoverBudgetAdjustment,
} from "@/ui/tables/budget/budgetAdjustmentRecovery";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type {
  BudgetAdjustmentCellLocation,
  BudgetAdjustmentFlushOutcome,
  BudgetAdjustmentRowsController,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import { logBudgetTableError } from "@/ui/tables/budget/table/logBudgetTableError";

const MAX_MONTH = "9999-12";

type BudgetAdjustmentEditorProps = Readonly<{
  editorId: string;
  location: BudgetAdjustmentCellLocation;
  currentMonth: string;
  categories: ReadonlyArray<string>;
  effectiveAllowlist: ReadonlySet<string> | null;
  editorAnchorByAdjustmentId: ReadonlyMap<
    string,
    BudgetAdjustmentCellLocation
  >;
  controller: BudgetAdjustmentRowsController;
  onInitialFocusTargetChange: (
    target: HTMLInputElement | HTMLButtonElement | null,
  ) => void;
  onInteraction: (adjustmentId: string) => void;
  onDeleteSuccess: (adjustmentId: string) => void;
  onSettlementSuccess: (adjustmentId: string) => void;
}>;

const getValidationMessageKey = (
  error: BudgetAdjustmentDraftError,
): "budget.adjustmentInvalidAmount" | "budget.adjustmentInvalidMonth" | "budget.adjustmentInvalidCategory" | "budget.adjustmentInvalidNote" => {
  switch (error.code) {
    case "invalidAmount":
    case "unsafeAmount":
      return "budget.adjustmentInvalidAmount";
    case "invalidMonth":
    case "pastMonth":
      return "budget.adjustmentInvalidMonth";
    case "invalidCategory":
      return "budget.adjustmentInvalidCategory";
    case "invalidNote":
      return "budget.adjustmentInvalidNote";
  }
};

type BudgetAdjustmentLocationField = "month" | "category";

type AsyncFocusRestorer = (
  getFocusTarget: () => HTMLElement | null | undefined,
) => void;

const getLocationValidationField = (
  error: BudgetAdjustmentDraftError,
): BudgetAdjustmentLocationField => {
  switch (error.code) {
    case "invalidMonth":
    case "pastMonth":
      return "month";
    case "invalidCategory":
      return "category";
    case "invalidAmount":
    case "unsafeAmount":
    case "invalidNote":
      throw new Error(
        `Expected a budget adjustment location error; received "${error.code}"`,
      );
  }
};

const isValidMonth = (month: string): boolean => (
  /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)
);

const getPreviousMonth = (month: string, currentMonth: string): string | null => {
  if (!isValidMonth(month) || month <= currentMonth) return null;
  return offsetMonth(month, -1);
};

const getNextMonth = (month: string): string | null => {
  if (!isValidMonth(month) || month >= MAX_MONTH) return null;
  return offsetMonth(month, 1);
};

const getDeleteAmount = (row: BudgetAdjustmentEditorRow): string => {
  const parsed = parseBudgetAdjustmentAmount(row.draft.amountInput);
  return parsed.ok ? String(parsed.amount) : row.draft.amountInput;
};

export const BudgetAdjustmentEditor = (
  props: BudgetAdjustmentEditorProps,
): ReactElement => {
  const {
    editorId,
    location,
    currentMonth,
    categories,
    effectiveAllowlist,
    editorAnchorByAdjustmentId,
    controller,
    onInitialFocusTargetChange,
    onInteraction,
    onDeleteSuccess,
    onSettlementSuccess,
  } = props;
  const { t } = useTranslation();
  const accessibilityId = useId();
  const rows = controller.getCellRows(
    location,
    effectiveAllowlist,
    editorAnchorByAdjustmentId,
  );
  const categoryOptions = useMemo<ReadonlyArray<string>>(
    () => getBudgetAdjustmentCategoryOptions(categories, effectiveAllowlist),
    [categories, effectiveAllowlist],
  );
  const categoryOptionSet = useMemo<ReadonlySet<string>>(
    () => new Set(categoryOptions),
    [categoryOptions],
  );
  const amountInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const noteInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
  const monthInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const categoryInputRefs = useRef<Map<string, HTMLSelectElement>>(new Map());
  const focusedAdjustmentIdRef = useRef<string | null>(null);
  const locationValidationFrameByAdjustmentIdRef = useRef<Map<string, number>>(
    new Map(),
  );
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteCancelButtonRef = useRef<HTMLButtonElement>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const shouldRestoreDeleteFocusRef = useRef<boolean>(false);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<BudgetAdjustmentEditorRow | null>(null);
  const [isDeletePending, setIsDeletePending] = useState<boolean>(false);

  useEffect(() => {
    if (pendingFocusId === null) return;
    const input = amountInputRefs.current.get(pendingFocusId);
    if (input === undefined) return;
    input.focus();
    setPendingFocusId(null);
  }, [controller.rows, pendingFocusId]);

  useEffect(
    () => (): void => onInitialFocusTargetChange(null),
    [onInitialFocusTargetChange],
  );

  useEffect(() => (): void => {
    for (const frame of locationValidationFrameByAdjustmentIdRef.current.values()) {
      window.cancelAnimationFrame(frame);
    }
    locationValidationFrameByAdjustmentIdRef.current.clear();
  }, []);

  useEffect(() => {
    if (deleteCandidate === null) return;
    const dialog = deleteDialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot open budget adjustment delete confirmation: dialog is not mounted");
    }
    if (!dialog.open) dialog.showModal();
    deleteCancelButtonRef.current?.focus();
  }, [deleteCandidate]);

  useEffect(() => {
    if (!isDeletePending) return;
    deleteDialogRef.current?.focus();
  }, [isDeletePending]);

  useEffect(() => {
    if (deleteCandidate !== null || !shouldRestoreDeleteFocusRef.current) return;
    shouldRestoreDeleteFocusRef.current = false;
    const returnTarget = deleteReturnFocusRef.current;
    deleteReturnFocusRef.current = null;
    if (returnTarget !== null && returnTarget.isConnected && !returnTarget.disabled) {
      returnTarget.focus();
      return;
    }
    addButtonRef.current?.focus();
  }, [controller.rows, deleteCandidate]);

  useEffect(() => {
    for (const row of rows) {
      if (
        row.draft.category === ""
        || categoryOptionSet.has(row.draft.category)
      ) {
        continue;
      }
      onInteraction(row.adjustmentId);
      controller.replaceDraft(row.adjustmentId, {
        ...row.draft,
        category: "",
      });
    }
  }, [categoryOptionSet, controller, onInteraction, rows]);

  useEffect(() => {
    const displayedAdjustmentIds = new Set(
      rows.map((row): string => row.adjustmentId),
    );
    for (const [adjustmentId, anchor] of editorAnchorByAdjustmentId) {
      if (
        anchor.month !== location.month
        || anchor.direction !== location.direction
        || anchor.category !== location.category
        || displayedAdjustmentIds.has(adjustmentId)
      ) {
        continue;
      }
      const currentRow = controller.getRow(adjustmentId, null);
      if (
        currentRow === null
        || (
          currentRow.confirmed.month === location.month
          && currentRow.direction === location.direction
          && currentRow.confirmed.category === location.category
        )
      ) {
        continue;
      }
      const rowOwnedFocus = focusedAdjustmentIdRef.current === adjustmentId;
      if (rowOwnedFocus) focusedAdjustmentIdRef.current = null;
      onSettlementSuccess(adjustmentId);
      if (!rowOwnedFocus) continue;
      window.requestAnimationFrame((): void => {
        const activeElement = document.activeElement;
        if (activeElement !== document.body && activeElement !== null) return;
        addButtonRef.current?.focus();
      });
    }
  }, [
    controller,
    editorAnchorByAdjustmentId,
    location.category,
    location.direction,
    location.month,
    onSettlementSuccess,
    rows,
  ]);

  const flushRow = (adjustmentId: string): void => {
    onInteraction(adjustmentId);
    void controller.flushRow(adjustmentId)
      .then((outcome): void => {
        if (isSuccessfulBudgetAdjustmentFlushOutcome(outcome)) {
          onSettlementSuccess(adjustmentId);
        }
      })
      .catch((error: unknown): void => {
        logBudgetTableError(`flush budget adjustment ${adjustmentId}`, error);
      });
  };

  const handleAdd = (): void => {
    const adjustmentId = controller.addRow(location);
    onInteraction(adjustmentId);
    setPendingFocusId(adjustmentId);
    flushRow(adjustmentId);
  };

  const replaceDraft = (
    row: BudgetAdjustmentEditorRow,
    draft: BudgetAdjustmentEditorRow["draft"],
  ): void => {
    onInteraction(row.adjustmentId);
    controller.replaceDraft(row.adjustmentId, draft);
  };

  const reportInvalidNonLocationField = (
    row: BudgetAdjustmentEditorRow,
  ): boolean => {
    const amount = parseBudgetAdjustmentAmount(row.draft.amountInput);
    if (!amount.ok) {
      const input = amountInputRefs.current.get(row.adjustmentId);
      input?.setCustomValidity(t(getValidationMessageKey(amount.error)));
      input?.focus();
      input?.reportValidity();
      return true;
    }
    if (!isValidBudgetAdjustmentNoteInput(row.draft.noteInput)) {
      const input = noteInputRefs.current.get(row.adjustmentId);
      input?.setCustomValidity(t("budget.adjustmentInvalidNote"));
      input?.focus();
      input?.reportValidity();
      return true;
    }
    return false;
  };

  const cancelLocationValidationFrame = (adjustmentId: string): void => {
    const frame = locationValidationFrameByAdjustmentIdRef.current.get(
      adjustmentId,
    );
    if (frame === undefined) return;
    window.cancelAnimationFrame(frame);
    locationValidationFrameByAdjustmentIdRef.current.delete(adjustmentId);
  };

  const clearLocationInputValidity = (adjustmentId: string): void => {
    cancelLocationValidationFrame(adjustmentId);
    monthInputRefs.current.get(adjustmentId)?.setCustomValidity("");
    categoryInputRefs.current.get(adjustmentId)?.setCustomValidity("");
  };

  const getLocationInput = (
    adjustmentId: string,
    field: BudgetAdjustmentLocationField,
  ): HTMLInputElement | HTMLSelectElement | undefined => (
    field === "month"
      ? monthInputRefs.current.get(adjustmentId)
      : categoryInputRefs.current.get(adjustmentId)
  );

  const reportLocationValidation = (
    adjustmentId: string,
    error: BudgetAdjustmentDraftError,
    actionTarget: HTMLElement,
  ): void => {
    const field = getLocationValidationField(error);
    const message = t(getValidationMessageKey(error));
    let frame = 0;
    frame = window.requestAnimationFrame((): void => {
      if (
        locationValidationFrameByAdjustmentIdRef.current.get(adjustmentId)
        !== frame
      ) {
        return;
      }
      locationValidationFrameByAdjustmentIdRef.current.delete(adjustmentId);
      const currentRow = controller.getRow(adjustmentId, null);
      if (currentRow === null) return;
      const currentValidation = parseBudgetAdjustmentDraft(
        currentRow.draft,
        currentMonth,
      );
      if (currentValidation.ok || currentValidation.error.code !== error.code) {
        return;
      }
      const input = getLocationInput(adjustmentId, field);
      if (input === undefined) return;
      input.setCustomValidity(message);
      if (document.activeElement !== actionTarget) return;
      input.focus();
      input.reportValidity();
    });
    locationValidationFrameByAdjustmentIdRef.current.set(adjustmentId, frame);
  };

  const captureFocusAfterAsyncAction = (
    actionTarget: HTMLElement,
  ): AsyncFocusRestorer => {
    const actionOwnedFocus = document.activeElement === actionTarget;
    return (getFocusTarget): void => {
      window.requestAnimationFrame((): void => {
        const activeElement = document.activeElement;
        const actionLostFocus = (
          actionOwnedFocus
          || !actionTarget.isConnected
        ) && (activeElement === document.body || activeElement === null);
        if (activeElement !== actionTarget && !actionLostFocus) return;
        getFocusTarget()?.focus();
      });
    };
  };

  const replaceLocationDraft = async (
    row: BudgetAdjustmentEditorRow,
    draft: BudgetAdjustmentEditorRow["draft"],
    field: BudgetAdjustmentLocationField,
    actionTarget: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  ): Promise<void> => {
    if (draft.month === row.draft.month && draft.category === row.draft.category) return;
    if (reportInvalidNonLocationField(row)) return;

    clearLocationInputValidity(row.adjustmentId);
    replaceDraft(row, draft);
    const parsed = parseBudgetAdjustmentDraft(draft, currentMonth);
    if (!parsed.ok) {
      reportLocationValidation(
        row.adjustmentId,
        parsed.error,
        actionTarget,
      );
      return;
    }

    const restoreFocus = captureFocusAfterAsyncAction(actionTarget);
    let outcome: BudgetAdjustmentFlushOutcome;
    try {
      outcome = await controller.flushRow(row.adjustmentId);
    } catch (error: unknown) {
      logBudgetTableError(
        `move budget adjustment ${row.adjustmentId}`,
        error,
      );
      restoreFocus(() => getLocationInput(row.adjustmentId, field));
      return;
    }
    if (!isSuccessfulBudgetAdjustmentFlushOutcome(outcome)) {
      restoreFocus(() => getLocationInput(row.adjustmentId, field));
      return;
    }

    const currentRow = controller.getRow(row.adjustmentId, null);
    const remainsInCell = currentRow !== null
      && currentRow.confirmed.month === location.month
      && currentRow.direction === location.direction
      && currentRow.confirmed.category === location.category;
    if (remainsInCell) {
      restoreFocus(() => getLocationInput(row.adjustmentId, field));
      return;
    }
    onSettlementSuccess(row.adjustmentId);
    restoreFocus(() => addButtonRef.current);
  };

  const setAddButton = (element: HTMLButtonElement | null): void => {
    addButtonRef.current = element;
    if (rows.length === 0) onInitialFocusTargetChange(element);
  };

  const setAmountInput = (
    adjustmentId: string,
    isFirstRow: boolean,
    element: HTMLInputElement | null,
  ): void => {
    if (element === null) amountInputRefs.current.delete(adjustmentId);
    else amountInputRefs.current.set(adjustmentId, element);
    if (isFirstRow) {
      onInitialFocusTargetChange(element ?? addButtonRef.current);
    }
  };

  const handleEditorKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    adjustmentId: string,
  ): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    flushRow(adjustmentId);
  };

  const getRecoveryFocusTarget = (
    adjustmentId: string,
  ): HTMLElement | undefined => {
    const currentRow = controller.getRow(adjustmentId, null);
    if (currentRow === null) return undefined;
    const parsed = parseBudgetAdjustmentDraft(currentRow.draft, currentMonth);
    if (parsed.ok) return amountInputRefs.current.get(adjustmentId);
    switch (parsed.error.code) {
      case "invalidAmount":
      case "unsafeAmount":
        return amountInputRefs.current.get(adjustmentId);
      case "invalidMonth":
      case "pastMonth":
        return monthInputRefs.current.get(adjustmentId);
      case "invalidCategory":
        return categoryInputRefs.current.get(adjustmentId);
      case "invalidNote":
        return noteInputRefs.current.get(adjustmentId);
    }
  };

  const handleErrorAction = async (
    row: BudgetAdjustmentEditorRow,
    actionTarget: HTMLButtonElement,
  ): Promise<void> => {
    if (!controller.errorByAdjustmentId.has(row.adjustmentId)) return;
    const restoreFocus = captureFocusAfterAsyncAction(actionTarget);
    onInteraction(row.adjustmentId);
    try {
      const outcome = await recoverBudgetAdjustment(
        controller,
        row.adjustmentId,
      );
      if (outcome !== "recovered") {
        restoreFocus(() => getRecoveryFocusTarget(row.adjustmentId));
        return;
      }
      const currentRow = controller.getRow(row.adjustmentId, null);
      const rowLeftEditor = (
        currentRow === null
        || currentRow.confirmed.month !== location.month
        || currentRow.direction !== location.direction
        || currentRow.confirmed.category !== location.category
      );
      onSettlementSuccess(row.adjustmentId);
      restoreFocus(() => rowLeftEditor
        ? addButtonRef.current
        : getRecoveryFocusTarget(row.adjustmentId));
    } catch (cause: unknown) {
      logBudgetTableError(`recover budget adjustment ${row.adjustmentId}`, cause);
      restoreFocus(() => getRecoveryFocusTarget(row.adjustmentId));
    }
  };

  const closeDeleteDialog = (): void => {
    const dialog = deleteDialogRef.current;
    if (dialog !== null && dialog.open) dialog.close();
    shouldRestoreDeleteFocusRef.current = true;
    setDeleteCandidate(null);
  };

  const handleDeleteDialogKeyDown = (
    event: React.KeyboardEvent<HTMLDialogElement>,
  ): void => {
    if (event.key !== "Tab") return;
    const dialog = deleteDialogRef.current;
    if (dialog === null) {
      throw new Error("Cannot contain budget adjustment delete focus: dialog is not mounted");
    }
    const focusableElements = [...dialog.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    )];
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;
    const focusIsOutside = activeElement === null || !dialog.contains(activeElement);
    if (event.shiftKey && (activeElement === firstElement || focusIsOutside)) {
      event.preventDefault();
      lastElement.focus();
      return;
    }
    if (!event.shiftKey && (activeElement === lastElement || focusIsOutside)) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (deleteCandidate === null) return;
    const adjustmentId = deleteCandidate.adjustmentId;
    onInteraction(adjustmentId);
    setIsDeletePending(true);
    try {
      const outcome = await controller.requestDelete(adjustmentId);
      if (outcome === "deleted") onDeleteSuccess(adjustmentId);
      closeDeleteDialog();
    } catch (error: unknown) {
      logBudgetTableError(`delete budget adjustment ${adjustmentId}`, error);
      closeDeleteDialog();
    } finally {
      setIsDeletePending(false);
    }
  };

  return (
    <section className={styles.adjustmentSection} aria-labelledby={`${accessibilityId}-adjustments-title`}>
      <div className={styles.adjustmentSectionHeader}>
        <h2 id={`${accessibilityId}-adjustments-title`} className={styles.adjustmentTitle}>
          {t("budget.adjustments")}
        </h2>
        <button
          ref={setAddButton}
          type="button"
          className={styles.adjustmentAddButton}
          data-testid={`budget-adjustment-add-${editorId}`}
          onClick={handleAdd}
        >
          {t("budget.adjustmentAdd")}
        </button>
      </div>
      <div className={styles.adjustmentTable} role="table" aria-label={t("budget.adjustments")}>
        <div className={styles.adjustmentTableHeader} role="row">
          <span role="columnheader">{t("budget.adjustmentAmount")}</span>
          <span role="columnheader">{t("budget.adjustmentNote")}</span>
          <span role="columnheader">{t("budget.adjustmentMonth")}</span>
          <span role="columnheader">{t("budget.adjustmentCategory")}</span>
          <span aria-hidden="true" />
        </div>
        {rows.map((row, rowIndex) => {
          const validation = controller.validationByAdjustmentId.get(row.adjustmentId);
          const rowError = controller.errorByAdjustmentId.get(row.adjustmentId);
          const operation = controller.operationByAdjustmentId.get(row.adjustmentId);
          const validationMessage = validation === undefined
            ? null
            : t(getValidationMessageKey(validation));
          const errorId = `${accessibilityId}-${row.adjustmentId}-error`;
          const categoryCorrectionErrorId =
            `${accessibilityId}-${row.adjustmentId}-category-correction`;
          const previousMonth = getPreviousMonth(row.draft.month, currentMonth);
          const nextMonth = getNextMonth(row.draft.month);
          const categoryUnavailable = !categoryOptionSet.has(
            row.draft.category,
          );
          const showCategoryCorrectionError = categoryUnavailable
            && validation?.code !== "invalidCategory";
          const amountInvalid = validation?.code === "invalidAmount"
            || validation?.code === "unsafeAmount";
          const monthInvalid = validation?.code === "invalidMonth"
            || validation?.code === "pastMonth";
          const categoryInvalid = categoryUnavailable
            || validation?.code === "invalidCategory";
          const noteInvalid = validation?.code === "invalidNote";

          return (
            <div
              key={row.adjustmentId}
              className={styles.adjustmentRow}
              role="row"
              data-testid={`budget-adjustment-row-${row.adjustmentId}`}
              onFocusCapture={(): void => {
                focusedAdjustmentIdRef.current = row.adjustmentId;
              }}
              onBlurCapture={(event): void => {
                const nextTarget = event.relatedTarget;
                if (
                  nextTarget instanceof Node
                  && event.currentTarget.contains(nextTarget)
                ) {
                  return;
                }
                const rowElement = event.currentTarget;
                queueMicrotask((): void => {
                  if (
                    !rowElement.isConnected
                    || focusedAdjustmentIdRef.current !== row.adjustmentId
                    || rowElement.contains(document.activeElement)
                  ) {
                    return;
                  }
                  focusedAdjustmentIdRef.current = null;
                });
              }}
            >
              <label className={styles.adjustmentField} role="cell">
                <span className={styles.adjustmentMobileLabel}>{t("budget.adjustmentAmount")}</span>
                <input
                  ref={(element) => setAmountInput(
                    row.adjustmentId,
                    rowIndex === 0,
                    element,
                  )}
                  type="text"
                  inputMode="numeric"
                  pattern="[+-]?[0-9]*"
                  className={styles.adjustmentInput}
                  data-testid={`budget-adjustment-amount-${row.adjustmentId}`}
                  aria-label={t("budget.adjustmentAmount")}
                  aria-invalid={amountInvalid}
                  aria-describedby={amountInvalid && validationMessage !== null ? errorId : undefined}
                  value={row.draft.amountInput}
                  onChange={(event) => {
                    event.currentTarget.setCustomValidity("");
                    replaceDraft(row, {
                      ...row.draft,
                      amountInput: event.target.value,
                    });
                  }}
                  onBlur={() => flushRow(row.adjustmentId)}
                  onKeyDown={(event) => handleEditorKeyDown(event, row.adjustmentId)}
                />
              </label>
              <label className={styles.adjustmentField} role="cell">
                <span className={styles.adjustmentMobileLabel}>{t("budget.adjustmentNote")}</span>
                <textarea
                  className={`${styles.adjustmentInput} ${styles.adjustmentNoteInput}`}
                  data-testid={`budget-adjustment-note-${row.adjustmentId}`}
                  aria-label={t("budget.adjustmentNote")}
                  aria-invalid={noteInvalid}
                  aria-describedby={noteInvalid && validationMessage !== null ? errorId : undefined}
                  rows={1}
                  value={row.draft.noteInput}
                  ref={(element) => {
                    if (element === null) noteInputRefs.current.delete(row.adjustmentId);
                    else noteInputRefs.current.set(row.adjustmentId, element);
                  }}
                  onChange={(event) => {
                    event.currentTarget.setCustomValidity("");
                    replaceDraft(row, {
                      ...row.draft,
                      noteInput: event.target.value,
                    });
                  }}
                  onBlur={() => flushRow(row.adjustmentId)}
                />
              </label>
              <div className={styles.adjustmentField} role="cell">
                <span className={styles.adjustmentMobileLabel}>{t("budget.adjustmentMonth")}</span>
                <div className={styles.adjustmentMonthControls}>
                  <button
                    type="button"
                    className={styles.adjustmentMonthButton}
                    data-testid={`budget-adjustment-month-previous-${row.adjustmentId}`}
                    aria-label={t("budget.adjustmentPreviousMonth")}
                    disabled={previousMonth === null}
                    onClick={(event) => {
                      if (previousMonth === null) return;
                      void replaceLocationDraft(
                        row,
                        { ...row.draft, month: previousMonth },
                        "month",
                        event.currentTarget,
                      );
                    }}
                  >
                    −1
                  </button>
                  <input
                    ref={(element) => {
                      if (element === null) {
                        monthInputRefs.current.delete(row.adjustmentId);
                      } else {
                        monthInputRefs.current.set(row.adjustmentId, element);
                      }
                    }}
                    type="month"
                    className={styles.adjustmentMonthInput}
                    data-testid={`budget-adjustment-month-${row.adjustmentId}`}
                    aria-label={t("budget.adjustmentMonth")}
                    aria-invalid={monthInvalid}
                    aria-describedby={monthInvalid && validationMessage !== null ? errorId : undefined}
                    required
                    min={currentMonth}
                    max={MAX_MONTH}
                    value={row.draft.month}
                    onChange={(event) => {
                      void replaceLocationDraft(
                        row,
                        { ...row.draft, month: event.target.value },
                        "month",
                        event.currentTarget,
                      );
                    }}
                    onBlur={() => flushRow(row.adjustmentId)}
                    onKeyDown={(event) => handleEditorKeyDown(event, row.adjustmentId)}
                  />
                  <button
                    type="button"
                    className={styles.adjustmentMonthButton}
                    data-testid={`budget-adjustment-month-next-${row.adjustmentId}`}
                    aria-label={t("budget.adjustmentNextMonth")}
                    disabled={nextMonth === null}
                    onClick={(event) => {
                      if (nextMonth === null) return;
                      void replaceLocationDraft(
                        row,
                        { ...row.draft, month: nextMonth },
                        "month",
                        event.currentTarget,
                      );
                    }}
                  >
                    +1
                  </button>
                </div>
              </div>
              <label className={styles.adjustmentField} role="cell">
                <span className={styles.adjustmentMobileLabel}>{t("budget.adjustmentCategory")}</span>
                <select
                  ref={(element) => {
                    if (element === null) {
                      categoryInputRefs.current.delete(row.adjustmentId);
                    } else {
                      categoryInputRefs.current.set(row.adjustmentId, element);
                    }
                  }}
                  className={styles.adjustmentSelect}
                  data-testid={`budget-adjustment-category-${row.adjustmentId}`}
                  aria-label={t("budget.adjustmentCategory")}
                  aria-invalid={categoryInvalid}
                  aria-describedby={
                    showCategoryCorrectionError
                      ? categoryCorrectionErrorId
                      : categoryInvalid && validationMessage !== null
                        ? errorId
                        : undefined
                  }
                  required
                  value={categoryUnavailable ? "" : row.draft.category}
                  onChange={(event) => {
                    void replaceLocationDraft(
                      row,
                      { ...row.draft, category: event.target.value },
                      "category",
                      event.currentTarget,
                    );
                  }}
                  onBlur={() => flushRow(row.adjustmentId)}
                  onKeyDown={(event) => handleEditorKeyDown(event, row.adjustmentId)}
                >
                  {categoryUnavailable && <option value="" disabled />}
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>
              <div className={styles.adjustmentRowActions} role="cell">
                <button
                  type="button"
                  className={styles.adjustmentDeleteButton}
                  data-testid={`budget-adjustment-delete-${row.adjustmentId}`}
                  aria-label={t("budget.adjustmentDelete")}
                  onClick={(event) => {
                    deleteReturnFocusRef.current = event.currentTarget;
                    setDeleteCandidate(row);
                  }}
                >
                  ×
                </button>
              </div>
              <span className={styles.adjustmentStatus} aria-live="polite">
                {operation === undefined
                  ? null
                  : operation === "deleting"
                    ? t("budget.adjustmentDeleting")
                    : t("common.saving")}
              </span>
              {validationMessage !== null && (
                <span id={errorId} className={styles.adjustmentError} role="alert">
                  {validationMessage}
                </span>
              )}
              {showCategoryCorrectionError && (
                <span
                  id={categoryCorrectionErrorId}
                  className={styles.adjustmentError}
                  role="alert"
                >
                  {t("budget.adjustmentInvalidCategory")}
                </span>
              )}
              {rowError !== undefined && (
                <span className={styles.adjustmentError} role="alert">
                  <span>{t("budget.adjustmentSaveFailed")}</span>
                  <button
                    type="button"
                    className={styles.adjustmentRecoveryButton}
                    data-testid={`budget-adjustment-recovery-${row.adjustmentId}`}
                    disabled={controller.recoveringAdjustmentIds.has(
                      row.adjustmentId,
                    )}
                    onClick={(event) => void handleErrorAction(
                      row,
                      event.currentTarget,
                    )}
                  >
                    {rowError.action === "refresh-range"
                      ? t("budget.adjustmentRefresh")
                      : t("budget.adjustmentRetry")}
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {deleteCandidate !== null && (
        <dialog
          ref={deleteDialogRef}
          className={styles.adjustmentModal}
          aria-labelledby={`${accessibilityId}-delete-title`}
          aria-describedby={`${accessibilityId}-delete-description`}
          data-testid={`budget-adjustment-delete-dialog-${deleteCandidate.adjustmentId}`}
          data-budget-adjustment-delete-dialog="true"
          tabIndex={-1}
          onKeyDown={handleDeleteDialogKeyDown}
          onCancel={(event) => {
            event.preventDefault();
            if (!isDeletePending) closeDeleteDialog();
          }}
        >
          <h2 id={`${accessibilityId}-delete-title`} className={styles.adjustmentModalTitle}>
            {t("budget.adjustmentDeleteTitle")}
          </h2>
          <p id={`${accessibilityId}-delete-description`} className={styles.adjustmentModalDescription}>
            {t("budget.adjustmentDeleteDescription")}
          </p>
          <dl className={styles.adjustmentDeleteSummary}>
            <div><dt>{t("budget.adjustmentAmount")}</dt><dd>{getDeleteAmount(deleteCandidate)}</dd></div>
            <div><dt>{t("budget.adjustmentNote")}</dt><dd>{deleteCandidate.draft.noteInput || "—"}</dd></div>
            <div><dt>{t("budget.adjustmentMonth")}</dt><dd>{deleteCandidate.draft.month}</dd></div>
            <div><dt>{t("budget.adjustmentCategory")}</dt><dd>{deleteCandidate.draft.category}</dd></div>
          </dl>
          <div className={styles.adjustmentModalActions}>
            <button
              ref={deleteCancelButtonRef}
              type="button"
              className={styles.adjustmentModalCancel}
              data-testid={`budget-adjustment-delete-cancel-${deleteCandidate.adjustmentId}`}
              disabled={isDeletePending}
              onClick={closeDeleteDialog}
            >
              {t("budget.adjustmentCancel")}
            </button>
            <button
              type="button"
              className={styles.adjustmentModalConfirm}
              data-testid={`budget-adjustment-delete-confirm-${deleteCandidate.adjustmentId}`}
              disabled={isDeletePending}
              onClick={() => void handleConfirmDelete()}
            >
              {isDeletePending ? t("budget.adjustmentDeleting") : t("budget.adjustmentDeleteConfirm")}
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
};
