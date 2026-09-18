"use client";

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  parseBudgetCategoryName,
  type BudgetCategoryNameError,
} from "@/ui/tables/budget/budgetCategoryName";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

type AddCategoryRowProps = Readonly<{
  direction: string;
  valueColumnCount: number;
  onAddCategory: (direction: string, category: string) => void;
}>;

const ERROR_MESSAGE_KEY: Readonly<Record<BudgetCategoryNameError, string>> = {
  empty: "budget.addCategoryEmpty",
  tooLong: "budget.addCategoryTooLong",
};

/**
 * Trailing row of a direction block that names a new category. The name only
 * enters the session state here; it becomes a stored category as soon as the
 * user saves a plan value in one of its cells.
 */
export const AddCategoryRow = ({
  direction,
  valueColumnCount,
  onAddCategory,
}: AddCategoryRowProps): ReactElement => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<BudgetCategoryNameError | null>(null);

  const cancelDraft = (): void => {
    setDraft(null);
    setError(null);
  };

  const commitParsedName = (name: string): void => {
    // A name that already exists in this direction adds no second row: the
    // grid dedupes it and simply shows the category the user named.
    onAddCategory(direction, name);
    cancelDraft();
  };

  const commitDraft = (): void => {
    if (draft === null) {
      return;
    }
    const parsed = parseBudgetCategoryName(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    commitParsedName(parsed.name);
  };

  // Leaving the input commits a name that parses, so clicking straight into the
  // grid cell the user is heading for never throws the typed name away. A name
  // that does not parse cannot be stored and so has nothing worth preserving:
  // the draft closes instead of leaving an unfocused input behind that neither
  // Escape nor the `+ Add category` button could reach.
  const commitOnBlur = (): void => {
    if (draft === null) {
      return;
    }
    const parsed = parseBudgetCategoryName(draft);
    if (!parsed.ok) {
      cancelDraft();
      return;
    }
    commitParsedName(parsed.name);
  };

  return (
    <tr className={styles.categoryRow}>
      <td className={`${styles.categoryLabel} ${styles.stickyCol}`}>
        {draft === null
          ? (
            <button
              type="button"
              className={styles.addCategoryButton}
              data-testid={`budget-add-category-${direction}`}
              onClick={(): void => setDraft("")}
            >
              {t("budget.addCategory")}
            </button>
          )
          : (
            <input
              type="text"
              className={styles.addCategoryInput}
              data-testid={`budget-add-category-input-${direction}`}
              aria-label={t("budget.addCategory")}
              aria-invalid={error !== null}
              autoFocus
              value={draft}
              onChange={(event): void => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event): void => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraft();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelDraft();
                }
              }}
              onBlur={commitOnBlur}
            />
          )}
      </td>
      <td className={styles.addCategoryMessage} colSpan={valueColumnCount}>
        {error !== null && (
          <span
            className={styles.addCategoryError}
            data-testid={`budget-add-category-error-${direction}`}
            role="alert"
          >
            {t(ERROR_MESSAGE_KEY[error])}
          </span>
        )}
      </td>
    </tr>
  );
};
