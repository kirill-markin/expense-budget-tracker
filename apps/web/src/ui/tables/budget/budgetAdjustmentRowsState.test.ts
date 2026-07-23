import assert from "node:assert/strict";
import test from "node:test";

import type {
  BudgetAdjustment,
  BudgetAdjustmentDirection,
} from "@/server/budget/budgetAdjustments";
import type { BudgetRow } from "@/server/budget/getBudgetGrid";
import {
  applyBudgetAdjustmentRows,
  applyBudgetAdjustmentRowsWithProtectedCells,
  budgetAdjustmentNoteFromInput,
  budgetAdjustmentNoteToInput,
  clearBudgetAdjustmentCellInvalidations,
  createBudgetAdjustmentEditorRow,
  getBudgetAdjustmentCategoryOptions,
  getBudgetAdjustmentCellKey,
  getBudgetAdjustmentCellRows,
  getBudgetAdjustmentCellTotal,
  getBudgetAdjustmentRowCellKey,
  isBudgetAdjustmentCategoryVisible,
  isBudgetAdjustmentRowVisible,
  isValidBudgetAdjustmentCategory,
  isValidBudgetAdjustmentNoteInput,
  parseBudgetAdjustmentAmount,
  parseBudgetAdjustmentDraft,
  recordBudgetAdjustmentCellMove,
  replaceBudgetAdjustmentDraft,
  sortBudgetAdjustmentRows,
  type BudgetAdjustmentDraft,
  type BudgetAdjustmentEditorRow,
  type BudgetAdjustmentSnapshot,
} from "@/ui/tables/budget/budgetAdjustmentRowsState";

const createAdjustment = (
  adjustmentId: string,
  amount: number,
  month: string,
  direction: BudgetAdjustmentDirection,
  category: string,
  note: string | null,
  createdAt: string,
): BudgetAdjustment => ({
  adjustmentId,
  amount,
  month,
  direction,
  category,
  note,
  createdAt,
  updatedAt: createdAt,
});

const createBudgetRow = (
  month: string,
  direction: string,
  category: string,
  plannedBase: number,
  plannedModifier: number,
): BudgetRow => ({
  month,
  direction,
  category,
  plannedBase,
  plannedModifier,
  planned: plannedBase + plannedModifier,
  actual: 0,
  hasUnconvertible: false,
});

const requireSnapshot = (
  draft: BudgetAdjustmentDraft,
  currentMonth: string,
): BudgetAdjustmentSnapshot => {
  const parsed = parseBudgetAdjustmentDraft(draft, currentMonth);
  if (!parsed.ok) throw new Error(`Expected a valid adjustment draft: ${parsed.error.message}`);
  return parsed.snapshot;
};

test("parses blank and signed integer amounts", (): void => {
  assert.deepEqual(parseBudgetAdjustmentAmount(""), { ok: true, amount: 0 });
  assert.deepEqual(parseBudgetAdjustmentAmount("   "), { ok: true, amount: 0 });
  assert.deepEqual(parseBudgetAdjustmentAmount("+42"), { ok: true, amount: 42 });
  assert.deepEqual(parseBudgetAdjustmentAmount(" -17 "), { ok: true, amount: -17 });
});

test("rejects decimal, text, and unsafe integer amounts with explicit errors", (): void => {
  const decimal = parseBudgetAdjustmentAmount("1.5");
  const text = parseBudgetAdjustmentAmount("twelve");
  const unsafe = parseBudgetAdjustmentAmount("9007199254740992");

  assert.equal(decimal.ok, false);
  assert.equal(decimal.ok ? null : decimal.error.code, "invalidAmount");
  assert.match(decimal.ok ? "" : decimal.error.message, /signed integer or blank/);
  assert.equal(text.ok, false);
  assert.equal(text.ok ? null : text.error.code, "invalidAmount");
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.ok ? null : unsafe.error.code, "unsafeAmount");
  assert.match(unsafe.ok ? "" : unsafe.error.message, /safe integer range/);
});

test("canonicalizes server and draft notes without losing editable text", (): void => {
  const nullNote = createBudgetAdjustmentEditorRow(createAdjustment(
    "null-note",
    10,
    "2026-07",
    "spend",
    "Groceries",
    null,
    "2026-07-01T00:00:00.000Z",
  ));
  const emptyNote = createBudgetAdjustmentEditorRow(createAdjustment(
    "empty-note",
    10,
    "2026-07",
    "spend",
    "Groceries",
    "",
    "2026-07-01T00:00:01.000Z",
  ));

  assert.equal(budgetAdjustmentNoteToInput(null), "");
  assert.equal(budgetAdjustmentNoteToInput(""), "");
  assert.equal(budgetAdjustmentNoteFromInput(""), null);
  assert.equal(budgetAdjustmentNoteFromInput("Draft text"), "Draft text");
  assert.equal(nullNote.draft.noteInput, "");
  assert.equal(nullNote.confirmed.note, null);
  assert.equal(emptyNote.draft.noteInput, "");
  assert.equal(emptyNote.confirmed.note, null);
  assert.equal(requireSnapshot({ ...nullNote.draft, noteInput: "Draft text" }, "2026-07").note, "Draft text");
});

test("accepts current and future months and rejects past months", (): void => {
  const draft: BudgetAdjustmentDraft = {
    amountInput: "0",
    noteInput: "",
    month: "2026-07",
    category: "Groceries",
  };

  assert.equal(parseBudgetAdjustmentDraft(draft, "2026-07").ok, true);
  assert.equal(parseBudgetAdjustmentDraft({ ...draft, month: "2026-08" }, "2026-07").ok, true);
  const past = parseBudgetAdjustmentDraft({ ...draft, month: "2026-06" }, "2026-07");
  assert.equal(past.ok, false);
  assert.equal(past.ok ? null : past.error.code, "pastMonth");
  assert.match(past.ok ? "" : past.error.message, /2026-07 or later/);
});

test("validates category and note limits by code point", (): void => {
  const draft: BudgetAdjustmentDraft = {
    amountInput: "0",
    noteInput: "",
    month: "2026-07",
    category: "Groceries",
  };
  const emptyCategory = parseBudgetAdjustmentDraft({ ...draft, category: "" }, "2026-07");
  const longNote = parseBudgetAdjustmentDraft(
    { ...draft, noteInput: "\u{1F680}".repeat(2001) },
    "2026-07",
  );

  assert.equal(emptyCategory.ok ? null : emptyCategory.error.code, "invalidCategory");
  assert.equal(longNote.ok ? null : longNote.error.code, "invalidNote");
  assert.equal(isValidBudgetAdjustmentNoteInput("\u{1F680}".repeat(2000)), true);
  assert.equal(isValidBudgetAdjustmentNoteInput("\u{1F680}".repeat(2001)), false);
});

test("accepts adjustment editor categories only within the category contract", (): void => {
  const maximumCategory = "\u{1F680}".repeat(200);
  const overlongCategory = "\u{1F680}".repeat(201);
  const categories = ["Groceries", "Dining", "", maximumCategory, overlongCategory, "Dining"];

  assert.equal(isValidBudgetAdjustmentCategory(""), false);
  assert.equal(isValidBudgetAdjustmentCategory(maximumCategory), true);
  assert.equal(isValidBudgetAdjustmentCategory(overlongCategory), false);
  assert.deepEqual(
    getBudgetAdjustmentCategoryOptions(categories, null),
    ["Groceries", "Dining", maximumCategory],
  );
});

test("does not expose masked categories in filtered adjustment options", (): void => {
  const categories = ["Groceries", "Dining", "Utilities"];

  assert.deepEqual(
    getBudgetAdjustmentCategoryOptions(categories, new Set(["Groceries", "Utilities"])),
    ["Groceries", "Utilities"],
  );
  assert.equal(
    isBudgetAdjustmentCategoryVisible("Unknown", new Set(["Groceries", "Utilities"])),
    false,
  );
});

test("keeps moved drafts private until confirmed and draft categories are both visible", (): void => {
  const confirmed = createBudgetAdjustmentEditorRow(createAdjustment(
    "masked-move",
    47,
    "2026-07",
    "spend",
    "Masked",
    "private note",
    "2026-07-01T00:00:00.000Z",
  ));
  const moved = replaceBudgetAdjustmentDraft([confirmed], confirmed.adjustmentId, {
    ...confirmed.draft,
    category: "Allowed",
  })[0];
  const allowlist = new Set(["Allowed"]);
  const visibleRows = [moved].filter((row): boolean =>
    isBudgetAdjustmentRowVisible(row, allowlist));

  assert.equal(isBudgetAdjustmentRowVisible(moved, allowlist), false);
  assert.equal(isBudgetAdjustmentRowVisible(moved, null), true);
  assert.deepEqual(getBudgetAdjustmentCellRows(
    visibleRows,
    "2026-07",
    "spend",
    "Allowed",
    "2026-07",
  ), []);
  assert.equal(getBudgetAdjustmentCellTotal(
    visibleRows,
    "2026-07",
    "spend",
    "Allowed",
    "2026-07",
  ), 0);
  assert.deepEqual(
    applyBudgetAdjustmentRows(
      [createBudgetRow("2026-07", "spend", "Allowed", 100, 47)],
      visibleRows,
      "2026-07",
      "2026-07",
      "2026-07",
      new Set(),
    ),
    [createBudgetRow("2026-07", "spend", "Allowed", 100, 0)],
  );
});

test("projects a retained adjustment-only cell only when its category is visible", (): void => {
  const protectedCell = {
    month: "2026-07",
    direction: "spend" as const,
    category: "Adjustment only",
  };

  const allProjection = applyBudgetAdjustmentRowsWithProtectedCells(
    [],
    [],
    "2026-07",
    "2026-07",
    "2026-07",
    new Set(),
    [protectedCell],
    null,
  );
  assert.deepEqual(allProjection, [
    createBudgetRow("2026-07", "spend", "Adjustment only", 0, 0),
  ]);
  assert.deepEqual(
    applyBudgetAdjustmentRowsWithProtectedCells(
      [],
      [],
      "2026-07",
      "2026-07",
      "2026-07",
      new Set(),
      [protectedCell],
      new Set(["Allowed"]),
    ),
    [],
  );
  assert.deepEqual(
    applyBudgetAdjustmentRowsWithProtectedCells(
      [],
      [],
      "2026-07",
      "2026-07",
      "2026-07",
      new Set(),
      [protectedCell],
      null,
    ),
    allProjection,
  );
  assert.deepEqual(
    applyBudgetAdjustmentRowsWithProtectedCells(
      [],
      [],
      "2026-07",
      "2026-07",
      "2026-07",
      new Set(),
      [],
      null,
    ),
    [],
  );
});

test("orders rows deterministically and selects an exact cell", (): void => {
  const laterId = createBudgetAdjustmentEditorRow(createAdjustment(
    "z-row", 1, "2026-08", "spend", "Dining", null, "2026-07-02T00:00:00.000Z",
  ));
  const earlierId = createBudgetAdjustmentEditorRow(createAdjustment(
    "a-row", 2, "2026-08", "spend", "Dining", null, "2026-07-02T00:00:00.000Z",
  ));
  const otherDirection = createBudgetAdjustmentEditorRow(createAdjustment(
    "income", 3, "2026-08", "income", "Dining", null, "2026-07-01T00:00:00.000Z",
  ));
  const earlierMonth = createBudgetAdjustmentEditorRow(createAdjustment(
    "july", 4, "2026-07", "spend", "Dining", null, "2026-07-03T00:00:00.000Z",
  ));
  const input = [laterId, otherDirection, earlierMonth, earlierId];

  assert.deepEqual(
    sortBudgetAdjustmentRows(input).map((row) => row.adjustmentId),
    ["july", "income", "a-row", "z-row"],
  );
  assert.deepEqual(
    getBudgetAdjustmentCellRows(input, "2026-08", "spend", "Dining", "2026-07")
      .map((row) => row.adjustmentId),
    ["a-row", "z-row"],
  );
  assert.deepEqual(input.map((row) => row.adjustmentId), ["z-row", "income", "july", "a-row"]);
});

test("aggregates multiple, cancelling, and zero-valued rows while keeping zero cells addressable", (): void => {
  const adjustments = [
    createAdjustment("first", 25, "2026-07", "spend", "Groceries", null, "2026-07-01T00:00:00.000Z"),
    createAdjustment("second", -10, "2026-07", "spend", "Groceries", null, "2026-07-01T00:00:01.000Z"),
    createAdjustment("cancel-a", 5, "2026-07", "spend", "Cancelling", null, "2026-07-01T00:00:02.000Z"),
    createAdjustment("cancel-b", -5, "2026-07", "spend", "Cancelling", null, "2026-07-01T00:00:03.000Z"),
    createAdjustment("zero", 0, "2026-07", "spend", "Zero", null, "2026-07-01T00:00:04.000Z"),
  ].map(createBudgetAdjustmentEditorRow);
  const budgetRows = [createBudgetRow("2026-07", "spend", "Groceries", 100, 999)];

  const result = applyBudgetAdjustmentRows(
    budgetRows,
    adjustments,
    "2026-07",
    "2026-07",
    "2026-07",
    new Set(),
  );
  const byCategory = new Map(result.map((row) => [row.category, row]));
  assert.equal(byCategory.get("Groceries")?.plannedModifier, 15);
  assert.equal(byCategory.get("Groceries")?.planned, 115);
  assert.equal(byCategory.get("Cancelling")?.plannedModifier, 0);
  assert.equal(byCategory.get("Zero")?.plannedModifier, 0);
  assert.deepEqual(
    getBudgetAdjustmentCellRows(adjustments, "2026-07", "spend", "Zero", "2026-07")
      .map((row) => row.adjustmentId),
    ["zero"],
  );
});

test("does not apply or synthesize adjustments before the explicit plan boundary", (): void => {
  const historical = createBudgetAdjustmentEditorRow(createAdjustment(
    "historical", 50, "2026-06", "spend", "Phantom", null, "2026-06-01T00:00:00.000Z",
  ));
  const current = createBudgetAdjustmentEditorRow(createAdjustment(
    "current", 20, "2026-07", "spend", "Current", null, "2026-07-01T00:00:00.000Z",
  ));
  const historicalActual: BudgetRow = {
    ...createBudgetRow("2026-06", "spend", "Existing", 0, 0),
    actual: 30,
  };

  const result = applyBudgetAdjustmentRows(
    [historicalActual],
    [historical, current],
    "2026-06",
    "2026-08",
    "2026-07",
    new Set(),
  );

  assert.equal(result.some((row) => row.month === "2026-06" && row.category === "Phantom"), false);
  assert.equal(result.some((row) => row.month === "2026-07" && row.category === "Current"), true);
  assert.deepEqual(result.find((row) => row.category === "Existing"), historicalActual);
  assert.equal(
    getBudgetAdjustmentCellTotal([historical], "2026-06", "spend", "Phantom", "2026-07"),
    0,
  );
});

test("keeps invalid draft locations in the confirmed cell without hiding validation errors", (): void => {
  const source = createBudgetAdjustmentEditorRow(createAdjustment(
    "invalid-location", 10, "2026-08", "spend", "Confirmed", null, "2026-07-01T00:00:00.000Z",
  ));
  const cases: ReadonlyArray<Readonly<{
    name: string;
    draft: BudgetAdjustmentDraft;
    errorCode: "invalidMonth" | "pastMonth" | "invalidCategory";
  }>> = [
    {
      name: "empty month",
      draft: { ...source.draft, amountInput: "25", month: "", category: "Draft" },
      errorCode: "invalidMonth",
    },
    {
      name: "malformed month",
      draft: { ...source.draft, amountInput: "25", month: "2026-13", category: "Draft" },
      errorCode: "invalidMonth",
    },
    {
      name: "past month",
      draft: { ...source.draft, amountInput: "25", month: "2026-06", category: "Draft" },
      errorCode: "pastMonth",
    },
    {
      name: "empty category",
      draft: { ...source.draft, amountInput: "25", month: "2026-09", category: "" },
      errorCode: "invalidCategory",
    },
    {
      name: "overlong category",
      draft: {
        ...source.draft,
        amountInput: "25",
        month: "2026-09",
        category: "\u{1F600}".repeat(201),
      },
      errorCode: "invalidCategory",
    },
  ];

  for (const input of cases) {
    const parsed = parseBudgetAdjustmentDraft(input.draft, "2026-07");
    assert.equal(parsed.ok ? null : parsed.error.code, input.errorCode, input.name);
    const rows = replaceBudgetAdjustmentDraft([source], source.adjustmentId, input.draft);
    assert.equal(
      getBudgetAdjustmentRowCellKey(rows[0], "2026-07"),
      getBudgetAdjustmentCellKey("2026-08", "spend", "Confirmed"),
      input.name,
    );
    assert.deepEqual(
      getBudgetAdjustmentCellRows(rows, "2026-08", "spend", "Confirmed", "2026-07")
        .map((row) => row.adjustmentId),
      [source.adjustmentId],
      input.name,
    );
    assert.equal(
      getBudgetAdjustmentCellTotal(rows, "2026-08", "spend", "Confirmed", "2026-07"),
      25,
      input.name,
    );
    const budget = applyBudgetAdjustmentRows(
      [createBudgetRow("2026-08", "spend", "Confirmed", 100, 10)],
      rows,
      "2026-07",
      "2026-09",
      "2026-07",
      new Set(),
    );
    assert.deepEqual(
      budget.map((row) => [row.month, row.category, row.planned]),
      [["2026-08", "Confirmed", 125]],
      input.name,
    );
  }
  assert.equal(recordBudgetAdjustmentCellMove(
    new Map(),
    {
      direction: source.direction,
      previous: source.confirmed,
      current: { ...source.confirmed, month: "", category: "Draft" },
    },
    1,
    "2026-07",
  ).size, 0);
});

test("sums safe integer adjustments exactly across unsafe intermediate totals", (): void => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const rows = [
    createAdjustment("maximum", maximum, "2026-07", "spend", "Exact", null, "2026-07-01T00:00:00.000Z"),
    createAdjustment("two", 2, "2026-07", "spend", "Exact", null, "2026-07-01T00:00:01.000Z"),
    createAdjustment("cancel", -maximum, "2026-07", "spend", "Exact", null, "2026-07-01T00:00:02.000Z"),
  ].map(createBudgetAdjustmentEditorRow);

  assert.equal(
    getBudgetAdjustmentCellTotal(rows, "2026-07", "spend", "Exact", "2026-07"),
    2,
  );
  const budget = applyBudgetAdjustmentRows([], rows, "2026-07", "2026-07", "2026-07", new Set());
  assert.equal(budget[0].plannedModifier, 2);
  assert.equal(budget[0].planned, 2);
});

test("rejects unsafe final adjustment totals and unsafe planned values", (): void => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const maximumRow = createBudgetAdjustmentEditorRow(createAdjustment(
    "maximum", maximum, "2026-07", "spend", "Unsafe", null, "2026-07-01T00:00:00.000Z",
  ));
  const oneRow = createBudgetAdjustmentEditorRow(createAdjustment(
    "one", 1, "2026-07", "spend", "Unsafe", null, "2026-07-01T00:00:01.000Z",
  ));

  assert.throws(
    () => getBudgetAdjustmentCellTotal(
      [maximumRow, oneRow],
      "2026-07",
      "spend",
      "Unsafe",
      "2026-07",
    ),
    /adjustment total.*outside the JavaScript safe integer range/,
  );
  assert.throws(
    () => applyBudgetAdjustmentRows(
      [createBudgetRow("2026-07", "spend", "Unsafe", maximum, 0)],
      [oneRow],
      "2026-07",
      "2026-07",
      "2026-07",
      new Set(),
    ),
    /planned value.*outside the JavaScript safe (?:integer|numeric) range/,
  );
});

test("moves a row across month and category without mutating source rows", (): void => {
  const source = createBudgetAdjustmentEditorRow(createAdjustment(
    "move", 40, "2026-07", "spend", "Groceries", null, "2026-07-01T00:00:00.000Z",
  ));
  const adjustmentRows = [source];
  const budgetRows = [
    createBudgetRow("2026-07", "spend", "Groceries", 100, 40),
    createBudgetRow("2026-08", "spend", "Dining", 20, 0),
  ];
  const originalBudgetRows = structuredClone(budgetRows);
  const moved = replaceBudgetAdjustmentDraft(adjustmentRows, source.adjustmentId, {
    ...source.draft,
    month: "2026-08",
    category: "Dining",
  });

  const result = applyBudgetAdjustmentRows(
    budgetRows,
    moved,
    "2026-07",
    "2026-08",
    "2026-07",
    new Set(),
  );
  const sourceCell = result.find((row) => row.month === "2026-07" && row.category === "Groceries");
  const destinationCell = result.find((row) => row.month === "2026-08" && row.category === "Dining");
  assert.equal(sourceCell?.plannedModifier, 0);
  assert.equal(sourceCell?.planned, 100);
  assert.equal(destinationCell?.plannedModifier, 40);
  assert.equal(destinationCell?.planned, 60);
  assert.equal(source.draft.month, "2026-07");
  assert.equal(source.draft.category, "Groceries");
  assert.deepEqual(budgetRows, originalBudgetRows);
});

test("zero-valued move provenance hides the stale source until a fresh-enough range", (): void => {
  const source = createBudgetAdjustmentEditorRow(createAdjustment(
    "zero-move", 0, "2026-07", "spend", "Source", null, "2026-07-01T00:00:00.000Z",
  ));
  const current = requireSnapshot({
    ...source.draft,
    month: "2026-08",
    category: "Destination",
  }, "2026-07");
  const moved = replaceBudgetAdjustmentDraft([source], source.adjustmentId, {
    ...source.draft,
    month: current.month,
    category: current.category,
  });
  const originalProvenance = new Map<string, number>();
  const provenance = recordBudgetAdjustmentCellMove(
    originalProvenance,
    { direction: source.direction, previous: source.confirmed, current },
    5,
    "2026-07",
  );
  const staleBudgetRows = [createBudgetRow("2026-07", "spend", "Source", 0, 0)];

  const result = applyBudgetAdjustmentRows(
    staleBudgetRows,
    moved,
    "2026-07",
    "2026-08",
    "2026-07",
    new Set(provenance.keys()),
  );
  assert.equal(result.some((row) => row.month === "2026-07" && row.category === "Source"), false);
  assert.equal(result.some((row) => row.month === "2026-08" && row.category === "Destination"), true);
  assert.equal(
    provenance.get(getBudgetAdjustmentCellKey("2026-07", "spend", "Source")),
    5,
  );
  assert.equal(clearBudgetAdjustmentCellInvalidations(provenance, "2026-07", "2026-07", 4).size, 1);
  assert.equal(clearBudgetAdjustmentCellInvalidations(provenance, "2026-07", "2026-07", 5).size, 0);
  assert.equal(originalProvenance.size, 0);
  assert.equal(provenance.size, 1);
  assert.equal(source.draft.month, "2026-07");
});

test("pure helpers reject invalid structural inputs without mutating inputs", (): void => {
  const row = createBudgetAdjustmentEditorRow(createAdjustment(
    "keep", 1, "2026-07", "spend", "Groceries", null, "2026-07-01T00:00:00.000Z",
  ));
  const rows: ReadonlyArray<BudgetAdjustmentEditorRow> = [row];
  const provenance = new Map([[getBudgetAdjustmentCellKey("2026-07", "spend", "Groceries"), 2]]);

  assert.throws(
    () => replaceBudgetAdjustmentDraft(rows, "missing", row.draft),
    /missing budget adjustment/,
  );
  assert.throws(
    () => clearBudgetAdjustmentCellInvalidations(provenance, "2026-08", "2026-07", 2),
    /must not be after/,
  );
  assert.deepEqual(rows, [row]);
  assert.equal(provenance.size, 1);
});
