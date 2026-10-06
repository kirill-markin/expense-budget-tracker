/**
 * Hover reason for a value that sums transfer legs with no second leg: the
 * movement only has one side, so the total it feeds is distorted. Explanation
 * only — it names the legs and offers no action.
 */
import type { UnpairedTransferLeg } from "@/server/budget/getBudgetGrid";

/** Legs named one by one; the rest collapse into a single trailing line. */
const MAX_LISTED_LEGS = 5;

export const buildUnpairedTransferLegsTitle = (
  legs: ReadonlyArray<UnpairedTransferLeg>,
  heading: string,
  formatLeg: (leg: UnpairedTransferLeg) => string,
  formatHiddenCount: (count: number) => string,
): string | null => {
  if (legs.length === 0) {
    return null;
  }
  const listed = legs.slice(0, MAX_LISTED_LEGS).map(formatLeg);
  const hiddenCount = legs.length - listed.length;
  const lines = hiddenCount === 0 ? listed : [...listed, formatHiddenCount(hiddenCount)];
  return [heading, ...lines].join("\n");
};
