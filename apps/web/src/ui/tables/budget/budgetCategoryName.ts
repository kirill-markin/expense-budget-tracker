/**
 * Parsing of a category name the user types into the budget grid. A category
 * exists only through the rows that carry it, so naming one here is the single
 * place a name enters the client before the first plan value is saved for it.
 */

/**
 * Matches the `length(category) <= 200` check on the budget tables, which
 * counts Unicode code points, as does every other measurement of this limit in
 * the client and the server contract.
 */
export const BUDGET_CATEGORY_NAME_MAX_LENGTH = 200;

export type BudgetCategoryNameError = "empty" | "tooLong";

export type BudgetCategoryNameParseResult =
  | Readonly<{ ok: true; name: string }>
  | Readonly<{ ok: false; error: BudgetCategoryNameError }>;

export const parseBudgetCategoryName = (input: string): BudgetCategoryNameParseResult => {
  const name = input.trim();
  if (name.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (Array.from(name).length > BUDGET_CATEGORY_NAME_MAX_LENGTH) {
    return { ok: false, error: "tooLong" };
  }
  return { ok: true, name };
};
