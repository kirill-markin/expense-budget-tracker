"use client";

import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { offsetMonth } from "@/lib/monthUtils";
import {
  getBudgetAdjustmentCategoryOptions,
  isValidBudgetAdjustmentNoteInput,
  parseBudgetAdjustmentAmount,
  type BudgetAdjustmentDraftError,
  type BudgetAdjustmentEditorRow,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type {
  BudgetAdjustmentCellLocation,
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
  controller: BudgetAdjustmentRowsController;
  onInitialFocusTargetChange: (
    target: HTMLInputElement | HTMLButtonElement | null,
  ) => void;
  onInteraction: (adjustmentId: string) => void;
  onDeleteSuccess: (adjustmentId: string) => void;
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
    controller,
    onInitialFocusTargetChange,
    onInteraction,
    onDeleteSuccess,
  } = props;
  const { t } = useTranslation();
  const accessibilityId = useId();
  const rows = controller.getCellRows(location, effectiveAllowlist);
  const categoryOptions = useMemo<ReadonlyArray<string>>(
    () => getBudgetAdjustmentCategoryOptions(categories, effectiveAllowlist),
    [categories, effectiveAllowlist],
  );
  const amountInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const noteInputRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());
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

  const flushRow = (adjustmentId: string): void => {
    onInteraction(adjustmentId);
    void controller.flushRow(adjustmentId).catch((error: unknown): void => {
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

  const replaceLocationDraft = (
    row: BudgetAdjustmentEditorRow,
    draft: BudgetAdjustmentEditorRow["draft"],
  ): void => {
    if (draft.month === row.draft.month && draft.category === row.draft.category) return;
    if (reportInvalidNonLocationField(row)) return;
    replaceDraft(row, draft);
    window.requestAnimationFrame((): void => addButtonRef.current?.focus());
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

  const handleErrorAction = (row: BudgetAdjustmentEditorRow): void => {
    const error = controller.errorByAdjustmentId.get(row.adjustmentId);
    if (error === undefined) return;
    onInteraction(row.adjustmentId);
    const operation = error.action === "refresh-range"
      ? controller.refreshRow(row.adjustmentId)
      : controller.flushRow(row.adjustmentId);
    void operation.catch((cause: unknown): void => {
      logBudgetTableError(`recover budget adjustment ${row.adjustmentId}`, cause);
    });
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
          const previousMonth = getPreviousMonth(row.draft.month, currentMonth);
          const nextMonth = getNextMonth(row.draft.month);
          const amountInvalid = validation?.code === "invalidAmount"
            || validation?.code === "unsafeAmount";
          const monthInvalid = validation?.code === "invalidMonth"
            || validation?.code === "pastMonth";
          const categoryInvalid = validation?.code === "invalidCategory";
          const noteInvalid = validation?.code === "invalidNote";

          return (
            <div
              key={row.adjustmentId}
              className={styles.adjustmentRow}
              role="row"
              data-testid={`budget-adjustment-row-${row.adjustmentId}`}
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
                    onClick={() => {
                      if (previousMonth === null) return;
                      replaceLocationDraft(row, { ...row.draft, month: previousMonth });
                    }}
                  >
                    −1
                  </button>
                  <input
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
                    onChange={(event) => replaceLocationDraft(row, {
                      ...row.draft,
                      month: event.target.value,
                    })}
                    onBlur={() => flushRow(row.adjustmentId)}
                    onKeyDown={(event) => handleEditorKeyDown(event, row.adjustmentId)}
                  />
                  <button
                    type="button"
                    className={styles.adjustmentMonthButton}
                    data-testid={`budget-adjustment-month-next-${row.adjustmentId}`}
                    aria-label={t("budget.adjustmentNextMonth")}
                    disabled={nextMonth === null}
                    onClick={() => {
                      if (nextMonth === null) return;
                      replaceLocationDraft(row, { ...row.draft, month: nextMonth });
                    }}
                  >
                    +1
                  </button>
                </div>
              </div>
              <label className={styles.adjustmentField} role="cell">
                <span className={styles.adjustmentMobileLabel}>{t("budget.adjustmentCategory")}</span>
                <select
                  className={styles.adjustmentSelect}
                  data-testid={`budget-adjustment-category-${row.adjustmentId}`}
                  aria-label={t("budget.adjustmentCategory")}
                  aria-invalid={categoryInvalid}
                  aria-describedby={categoryInvalid && validationMessage !== null ? errorId : undefined}
                  required
                  value={row.draft.category}
                  onChange={(event) => replaceLocationDraft(row, {
                    ...row.draft,
                    category: event.target.value,
                  })}
                  onBlur={() => flushRow(row.adjustmentId)}
                  onKeyDown={(event) => handleEditorKeyDown(event, row.adjustmentId)}
                >
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
              {rowError !== undefined && (
                <span className={styles.adjustmentError} role="alert">
                  <span>
                    {effectiveAllowlist === null
                      ? rowError.message
                      : t("budget.adjustmentSaveFailed")}
                  </span>
                  <button
                    type="button"
                    className={styles.adjustmentRecoveryButton}
                    onClick={() => handleErrorAction(row)}
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
