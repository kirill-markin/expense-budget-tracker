/**
 * Data visibility levels shared across budget dashboards.
 * - "hidden": all data masked
 * - "spend-only": spend visible (except sensitive categories), income masked
 * - "all": everything visible
 */
export type MaskLevel = "hidden" | "spend-only" | "all";

/**
 * Spend categories masked in "spend-only" mode.
 * These contain income-related or gift data that should stay private
 * when sharing the spend view. Edit this set to change which
 * categories are hidden in the "Spend" toggle.
 */
export const SENSITIVE_SPEND_CATEGORIES: ReadonlySet<string> = new Set([
  "Gifts",
  "Work Primary",
  "Work Secondary",
  "Taxes",
  "Consultants",
  "Ozma Inc.",
  "Help",
  "Bank Fees",
  "Other",
  "Adjustment",
]);

export type CellVisibility = Readonly<{
  showData: boolean;
  maskClass: string;
}>;

/**
 * Single source of truth for cell visibility in the budget table.
 * Returns whether a cell should display data and its CSS mask class.
 *
 * Rules by MaskLevel:
 * - "hidden": everything masked
 * - "spend-only": spend categories visible, except SENSITIVE_SPEND_CATEGORIES;
 *   income, remainder, and balance rows masked
 * - "all": everything visible
 */
export const getCellVisibility = (
  level: MaskLevel,
  direction: string,
  category: string | null,
): CellVisibility => {
  if (level === "all") return { showData: true, maskClass: "" };
  if (level === "hidden") return { showData: false, maskClass: " data-masked" };

  // "spend-only"
  if (direction !== "spend") return { showData: false, maskClass: " data-masked" };
  if (category !== null && SENSITIVE_SPEND_CATEGORIES.has(category)) {
    return { showData: false, maskClass: " data-masked" };
  }
  return { showData: true, maskClass: "" };
};

/** Whether a direction (income/spend) is visible at the given mask level. */
export const isDirectionVisible = (level: MaskLevel, direction: string): boolean => {
  if (level === "all") return true;
  if (level === "hidden") return false;
  return direction === "spend";
};

/** Whether a specific category within a direction is visible at the given mask level. */
export const isCategoryVisible = (
  level: MaskLevel,
  direction: string,
  category: string,
): boolean => {
  if (level === "all") return true;
  if (level === "hidden") return false;
  if (direction !== "spend") return false;
  return !SENSITIVE_SPEND_CATEGORIES.has(category);
};
