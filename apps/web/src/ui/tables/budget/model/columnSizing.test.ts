import assert from "node:assert/strict";
import test from "node:test";
import { buildBudgetColumnContent, getBudgetColumnInlineSize, getBudgetValuesInlineSize, type BudgetColumnSizingData } from "./columnSizing";
import { computeYearTotal } from "./yearTotals";
import { formatAmount, zeroCellValue, type CellValue } from "./cells";
import type { NumberFormat } from "@/lib/locale";

const labels = { plan: "Plan", actual: "Actual", total: "Total" };
const cell = (planned: number, actual: number, plannedModifier: number = 0): CellValue => ({
  plannedBase: planned - plannedModifier, plannedModifier, planned, actual,
});
const data = (overrides: Partial<BudgetColumnSizingData> = {}): BudgetColumnSizingData => ({
  columnSequence: [{ kind: "month", month: "2026-11" }],
  currentMonth: "2026-11", plansMode: "actuals", loadedFrom: "2026-11", loadedTo: "2026-11",
  blocks: [], effectiveAllowlist: null, filteredSubtotalsMap: new Map(),
  incomeSubtotals: undefined, spendSubtotals: undefined, transferSubtotals: undefined,
  yearComputed: new Map(), cumulativeBalances: new Map([["2026-11", { plan: 0, actual: 0, isTainted: false }]]),
  fxAdjustments: new Map(), hasBusinessAccount: false, businessPersonalTransfers: {},
  hasLiquidityBreakdown: false, liquidityTiers: [], mebByLiq: {}, projectedLiqBalances: new Map(),
  ...overrides,
});
const blocks = (value: CellValue): BudgetColumnSizingData["blocks"] => [{
  block: { direction: "income", label: "Income", categories: ["Salary"], cells: new Map([["2026-11::Salary", value]]), subtotals: new Map() },
  directionCategories: ["Salary"],
}];

test("counts grouped/negative values in every number format and keeps the CSS triangle separate", () => {
  for (const format of ["1,234.56", "1 234,56", "1.234,56", "1 234.56"] satisfies ReadonlyArray<NumberFormat>) {
    const [plan, actual] = buildBudgetColumnContent(data({ blocks: blocks(cell(9900001, -123456789, 1)) }), format, labels);
    assert.equal(plan.adjustedCharacters, formatAmount(9900001, format).length);
    assert.equal(plan.characters, 4);
    assert.equal(actual.characters, formatAmount(-123456789, format).length);
    assert.equal(actual.adjustedCharacters, 0);
    assert.match(getBudgetColumnInlineSize(plan), /var\(--budget-modifier-inline-size\) \+ var\(--budget-modifier-gap\)/);
    assert.match(getBudgetColumnInlineSize(plan), /2 \* var\(--budget-cell-padding\)/);
  }
});

test("covers signed remainder, FX, balances, liquidity, business transfers and subtotals", () => {
  const candidates: ReadonlyArray<Partial<BudgetColumnSizingData>> = [
    { incomeSubtotals: new Map([["2026-11", cell(123456789, 123456789)]]) },
    { fxAdjustments: new Map([["2026-11", -123456789]]) },
    { cumulativeBalances: new Map([["2026-11", { plan: -123456789, actual: -123456789, isTainted: false }]]) },
    { hasLiquidityBreakdown: true, liquidityTiers: ["cash"], mebByLiq: { "2026-11": { cash: -123456789 } }, projectedLiqBalances: new Map([["2026-11", { cash: -123456789 }]]) },
    { hasBusinessAccount: true, businessPersonalTransfers: { "2026-11": { actual: -123456789, hasUnconvertible: false } } },
    { blocks: [{ ...blocks(zeroCellValue)[0], block: { ...blocks(zeroCellValue)[0].block, subtotals: new Map([["2026-11", cell(-123456789, -123456789)]]) } }] },
  ];
  for (const candidate of candidates) {
    assert.equal(buildBudgetColumnContent(data(candidate), "1,234.56", labels)[1].characters, 12);
  }
});

test("year columns use full-year data and signed formatters without adjustment triangles", () => {
  const year = computeYearTotal([], { incomeActual: 0, spendActual: 0, transferActual: 0 }, {}, {}, {}, "2026", "2026-11", null, "actuals");
  const columns = buildBudgetColumnContent(data({
    columnSequence: [{ kind: "year-total", year: "2026" }], blocks: blocks(zeroCellValue),
    yearComputed: new Map([["2026", { ...year,
      directionCategoryTotals: new Map([["income", new Map([["Salary", cell(-123456789, -123456789, 1)]])]]),
      remainder: cell(9999999999, 9999999999),
    }]]),
  }), "1,234.56", labels);
  assert.deepEqual(columns.map((column) => column.characters), [14, 14]);
  assert.deepEqual(columns.map((column) => column.adjustedCharacters), [0, 0]);
});

test("covers single/spanned month and year headers, translations and responsive CSS padding", () => {
  const columns = buildBudgetColumnContent(data({
    columnSequence: [{ kind: "month", month: "2026-11" }, { kind: "year-total", year: "2025" }, { kind: "year-total", year: "2026" }],
  }), "1,234.56", { plan: "תכנון", actual: "Actual translated", total: "Translated total" });
  assert.deepEqual(columns.map((column) => column.headerSpan), [2, 2, 1, 2, 2]);
  assert.deepEqual(columns.map((column) => column.headerCharacters), [7, 7, 21, 21, 21]);
  assert.equal(columns[1].characters, 17);
  assert.match(getBudgetColumnInlineSize(columns[2]), /2 \* var\(--budget-single-year-header-padding\)/);
  assert.match(getBudgetColumnInlineSize(columns[3]), /21ch.*\/ 2/);
});

test("mode changes include elapsed plans; data edits update sizes without DOM access", () => {
  const input = data({ currentMonth: "2026-12", blocks: blocks(cell(-123456789, 1, 1)) });
  assert.equal(buildBudgetColumnContent(input, "1,234.56", labels).length, 1);
  const columns = buildBudgetColumnContent({ ...input, plansMode: "all-plans" }, "1,234.56", labels);
  assert.equal(columns.length, 2);
  assert.equal(columns[0].adjustedCharacters, 12);
  assert.equal(buildBudgetColumnContent({ ...input, currentMonth: "2026-11", blocks: blocks(cell(-123456789012, 1)) }, "1,234.56", labels)[0].characters, 16);
});

test("ignores masked and unloaded values while retaining filtered subtotals", () => {
  const input = data({ blocks: blocks(cell(-123456789012, -123456789012, 1)), effectiveAllowlist: new Set(),
    filteredSubtotalsMap: new Map([["income", new Map([["2026-11", cell(123456789, 123456789)]])]]) });
  assert.deepEqual(buildBudgetColumnContent(input, "1,234.56", labels).map((column) => [column.characters, column.adjustedCharacters]), [[11, 0], [11, 0]]);
  assert.deepEqual(buildBudgetColumnContent({ ...input, loadedTo: "2026-10" }, "1,234.56", labels).map((column) => column.characters), [4, 6]);
});

test("fails explicitly when a loaded month lacks its required balance", () => {
  assert.throws(() => buildBudgetColumnContent(data({ cumulativeBalances: new Map() }), "1,234.56", labels), /2026-11.*missing its cumulative balance/);
});


test("groups the fixed calendar's repeated CSS widths to avoid oversized math expressions", () => {
  const widths = Array.from({ length: 275 }, (_, index): string => index % 13 === 0 ? "max(84px, 10ch)" : "max(76px, 7ch)");
  assert.equal(getBudgetValuesInlineSize(widths), "calc(0px + 22 * max(84px, 10ch) + 253 * max(76px, 7ch))");
  assert.equal(getBudgetValuesInlineSize([]), "calc(0px)");
});
