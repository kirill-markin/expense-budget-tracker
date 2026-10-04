/**
 * Horizontal scroll anchoring for the budget table.
 *
 * Changing the display mode changes how many value columns every elapsed month
 * occupies, which inserts or removes content before the current scroll offset.
 * The month at the inline start of the value area and its offset are therefore
 * measured continuously while the user scrolls, and both are put back once the
 * new columns are laid out, which keeps the user looking at the months they
 * were reading.
 *
 * Offsets are measured along the inline axis, so right-to-left layouts mirror
 * them and the same arithmetic holds in both directions.
 */

export type BudgetScrollAnchor = Readonly<{
  month: string;
  /**
   * Distance from the inline-start edge of the value area to the inline-start
   * edge of the month. Negative while the month starts behind the sticky
   * category column.
   */
  inlineOffset: number;
}>;

export type BudgetScrollAnchorCandidate = Readonly<{
  month: string;
  inlineOffset: number;
  inlineSize: number;
}>;

/**
 * What to do with the latest measurement once a new column layout renders.
 *
 * - "restore": the measurement describes where the user was reading, so put
 *   its month back at its offset in the new columns.
 * - "reset": nothing has been measured yet, so the current month is the only
 *   sensible position left.
 */
export type BudgetScrollAnchorRestoration =
  | Readonly<{ action: "restore"; anchor: BudgetScrollAnchor }>
  | Readonly<{ action: "reset" }>;

/**
 * Decides how the latest measurement meets the layout that is about to be
 * shown.
 *
 * The anchor is re-measured from every scroll rather than captured when a mode
 * is requested, so it always describes the position the user is looking at and
 * can never go stale between the request and the layout that answers it. The
 * only measurement that does not exist is the one before the first row is laid
 * out, which falls back to the current month.
 */
export const selectBudgetScrollAnchorRestoration = (
  anchor: BudgetScrollAnchor | null,
): BudgetScrollAnchorRestoration => (
  anchor === null ? { action: "reset" } : { action: "restore", anchor }
);

/**
 * Inline offset of a measured box from the inline-start edge of the value area.
 *
 * `boxStart` and `boxEnd` are the physical left and right edges a rect reports;
 * in a right-to-left layout the inline-start edge is the right one.
 */
export const getBudgetScrollInlineOffset = (
  valueAreaInlineStart: number,
  boxStart: number,
  boxEnd: number,
  isRtl: boolean,
): number => {
  if (
    !Number.isFinite(valueAreaInlineStart)
    || !Number.isFinite(boxStart)
    || !Number.isFinite(boxEnd)
  ) {
    throw new RangeError(
      `Budget scroll offset needs finite edges, received value area ${valueAreaInlineStart} and box ${boxStart}..${boxEnd}`,
    );
  }
  return isRtl ? valueAreaInlineStart - boxEnd : boxStart - valueAreaInlineStart;
};

/**
 * The first candidate the value area still shows, in document order.
 *
 * Candidates must be ordered by column, so the first one whose inline end has
 * not passed the inline start of the value area is the leading visible month.
 * Returns null when no candidate qualifies, which leaves the caller its own
 * fallback.
 */
export const selectLeadingBudgetScrollAnchor = (
  candidates: ReadonlyArray<BudgetScrollAnchorCandidate>,
): BudgetScrollAnchor | null => {
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.inlineOffset)) {
      throw new RangeError(
        `Budget scroll anchor candidate ${candidate.month} needs a finite inline offset, received ${candidate.inlineOffset}`,
      );
    }
    if (!Number.isFinite(candidate.inlineSize) || candidate.inlineSize < 0) {
      throw new RangeError(
        `Budget scroll anchor candidate ${candidate.month} needs a non-negative inline size, received ${candidate.inlineSize}`,
      );
    }
    if (candidate.inlineOffset + candidate.inlineSize <= 0) {
      continue;
    }
    return { month: candidate.month, inlineOffset: candidate.inlineOffset };
  }
  return null;
};

/**
 * `scrollLeft` change that moves a box from its current inline offset to the
 * anchored one. `scrollLeft` grows toward the inline start in a right-to-left
 * layout, so the delta flips there.
 */
export const getBudgetScrollLeftDelta = (
  currentInlineOffset: number,
  anchorInlineOffset: number,
  isRtl: boolean,
): number => {
  if (
    !Number.isFinite(currentInlineOffset)
    || !Number.isFinite(anchorInlineOffset)
  ) {
    throw new RangeError(
      `Budget scroll delta needs finite offsets, received ${currentInlineOffset} and ${anchorInlineOffset}`,
    );
  }
  const delta = currentInlineOffset - anchorInlineOffset;
  return isRtl ? -delta : delta;
};
