import assert from "node:assert/strict";
import test from "node:test";

import {
  getBudgetScrollInlineOffset,
  getBudgetScrollLeftDelta,
  selectBudgetScrollAnchorRestoration,
  selectLeadingBudgetScrollAnchor,
  type BudgetScrollAnchor,
  type BudgetScrollAnchorCandidate,
} from "@/ui/tables/budget/controller/budgetScrollAnchor";

test("measures the inline offset from the reading-direction edge", (): void => {
  // Value area starts at 200; the month box covers 260..360.
  assert.equal(getBudgetScrollInlineOffset(200, 260, 360, false), 60);
  // Behind the sticky column.
  assert.equal(getBudgetScrollInlineOffset(200, 140, 240, false), -60);
  // In RTL the value area starts at its right edge and the box ends on its left.
  assert.equal(getBudgetScrollInlineOffset(800, 640, 740, true), 60);
  assert.equal(getBudgetScrollInlineOffset(800, 760, 860, true), -60);
});

test("rejects measurements the layout could not produce", (): void => {
  assert.throws(
    () => getBudgetScrollInlineOffset(Number.NaN, 0, 10, false),
    RangeError,
  );
  assert.throws(
    () => getBudgetScrollLeftDelta(0, Number.POSITIVE_INFINITY, false),
    RangeError,
  );
  assert.throws(
    () => selectLeadingBudgetScrollAnchor([
      { month: "2026-04", inlineOffset: 0, inlineSize: -1 },
    ]),
    RangeError,
  );
});

test("anchors the first month the value area still shows", (): void => {
  const candidates: ReadonlyArray<BudgetScrollAnchorCandidate> = [
    { month: "2026-01", inlineOffset: -300, inlineSize: 100 },
    { month: "2026-02", inlineOffset: -200, inlineSize: 100 },
    { month: "2026-03", inlineOffset: -40, inlineSize: 100 },
    { month: "2026-04", inlineOffset: 60, inlineSize: 100 },
  ];

  assert.deepEqual(selectLeadingBudgetScrollAnchor(candidates), {
    month: "2026-03",
    inlineOffset: -40,
  });
});

test("treats a month ending exactly at the value area as gone", (): void => {
  assert.deepEqual(
    selectLeadingBudgetScrollAnchor([
      { month: "2026-01", inlineOffset: -100, inlineSize: 100 },
      { month: "2026-02", inlineOffset: 0, inlineSize: 100 },
    ]),
    { month: "2026-02", inlineOffset: 0 },
  );
  assert.equal(
    selectLeadingBudgetScrollAnchor([
      { month: "2026-01", inlineOffset: -100, inlineSize: 100 },
    ]),
    null,
  );
  assert.equal(selectLeadingBudgetScrollAnchor([]), null);
});

test("scrolls by the inline drift the new columns introduced", (): void => {
  // The anchored month sat 60px into the value area and now starts 12400px
  // further along, so the scroller has to advance by the difference.
  assert.equal(getBudgetScrollLeftDelta(12460, 60, false), 12400);
  // RTL grows scrollLeft toward the inline start, so the same drift flips.
  assert.equal(getBudgetScrollLeftDelta(12460, 60, true), -12400);
  // An unchanged offset leaves the scroller alone in both directions.
  assert.equal(getBudgetScrollLeftDelta(60, 60, false), 0);
  assert.equal(getBudgetScrollLeftDelta(60, 60, true), 0);
});

test("keeps scrolling to a month flush with the value area equivalent", (): void => {
  // Mirrors the "Today" button: offset 0 for the current month.
  const ltrOffset = getBudgetScrollInlineOffset(200, 260, 360, false);
  assert.equal(getBudgetScrollLeftDelta(ltrOffset, 0, false), 60);
  const rtlOffset = getBudgetScrollInlineOffset(800, 640, 740, true);
  assert.equal(getBudgetScrollLeftDelta(rtlOffset, 0, true), -60);
});

test("restores the latest measured position in the new columns", (): void => {
  const anchor: BudgetScrollAnchor = { month: "2026-03", inlineOffset: -40 };

  assert.deepEqual(
    selectBudgetScrollAnchorRestoration(anchor),
    { action: "restore", anchor },
  );
});

test("falls back to the current month before anything was measured", (): void => {
  assert.deepEqual(
    selectBudgetScrollAnchorRestoration(null),
    { action: "reset" },
  );
});
