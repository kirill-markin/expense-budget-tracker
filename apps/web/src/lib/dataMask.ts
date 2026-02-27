export type CellVisibility = Readonly<{ showData: boolean; maskClass: string }>;

/**
 * Returns visibility for a cell given the current allowlist.
 * allowlist=null means "show all" (All mode).
 * allowlist !== null && category === null means aggregate row (Remainder/Balance) — always masked.
 * allowlist !== null && allowlist.has(category) — visible.
 * allowlist !== null && !allowlist.has(category) — masked.
 */
export const getCellVisibility = (
  allowlist: ReadonlySet<string> | null,
  category: string | null,
): CellVisibility => {
  if (allowlist === null) return { showData: true, maskClass: "" };
  if (category === null) return { showData: false, maskClass: " data-masked" };
  if (allowlist.has(category)) return { showData: true, maskClass: "" };
  return { showData: false, maskClass: " data-masked" };
};

/** Whether a category is visible given the current allowlist. */
export const isCategoryVisible = (
  allowlist: ReadonlySet<string> | null,
  category: string,
): boolean => {
  if (allowlist === null) return true;
  return allowlist.has(category);
};
