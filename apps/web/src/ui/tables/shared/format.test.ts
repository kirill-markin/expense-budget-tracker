import assert from "node:assert/strict";
import test from "node:test";

import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  parseMonetaryNumber,
  parseMonetaryNumberEdit,
} from "@/ui/tables/shared/format";

type FormatExpectations = Readonly<{
  positive: string;
  negative: string;
  rounded: string;
}>;

const EXPECTATIONS: Readonly<Record<NumberFormat, FormatExpectations>> = {
  "1,234.56": {
    positive: "1,234.56",
    negative: "-1,234.56",
    rounded: "1,234.57",
  },
  "1 234,56": {
    positive: "1\u00a0234,56",
    negative: "-1\u00a0234,56",
    rounded: "1\u00a0234,57",
  },
  "1.234,56": {
    positive: "1.234,56",
    negative: "-1.234,56",
    rounded: "1.234,57",
  },
  "1 234.56": {
    positive: "1 234.56",
    negative: "-1 234.56",
    rounded: "1 234.57",
  },
};

for (const [numberFormat, expected] of Object.entries(EXPECTATIONS) as ReadonlyArray<[NumberFormat, FormatExpectations]>) {
  test(`formatAmount preserves sign, zero, and rounding for ${numberFormat}`, (): void => {
    assert.equal(formatAmount(1234.56, numberFormat), expected.positive);
    assert.equal(formatAmount(-1234.56, numberFormat), expected.negative);
    assert.equal(formatAmount(0, numberFormat), "0");
    assert.equal(formatAmount(1234.567, numberFormat), expected.rounded);
  });
}

test("formatAmount uses an ordinary space for the space-dot format", (): void => {
  const formatted = formatAmount(1234.56, "1 234.56");

  assert.equal(formatted, "1\u0020234.56");
  assert.deepEqual(
    Array.from(formatted, (character): number => character.charCodeAt(0)),
    [0x31, 0x20, 0x32, 0x33, 0x34, 0x2e, 0x35, 0x36],
  );
  assert.equal(formatted.includes("\u00a0"), false);
  assert.equal(formatted.includes("\u202f"), false);
});

type ParseExpectation = Readonly<{
  selected: string;
  selectedNegative: string;
  selectedUngrouped: string;
}>;

const PARSE_EXPECTATIONS: Readonly<Record<NumberFormat, ParseExpectation>> = {
  "1,234.56": {
    selected: "1,234.56",
    selectedNegative: "-1,234.56",
    selectedUngrouped: "1234.56",
  },
  "1 234,56": {
    selected: "1 234,56",
    selectedNegative: "-1 234,56",
    selectedUngrouped: "1234,56",
  },
  "1.234,56": {
    selected: "1.234,56",
    selectedNegative: "-1.234,56",
    selectedUngrouped: "1234,56",
  },
  "1 234.56": {
    selected: "1 234.56",
    selectedNegative: "-1 234.56",
    selectedUngrouped: "1234.56",
  },
};

for (const [numberFormat, input] of Object.entries(PARSE_EXPECTATIONS) as ReadonlyArray<[NumberFormat, ParseExpectation]>) {
  test(`parseMonetaryNumber accepts canonical and selected syntax for ${numberFormat}`, (): void => {
    assert.deepEqual(parseMonetaryNumber("1234.56", numberFormat), { ok: true, value: 1234.56 });
    assert.deepEqual(parseMonetaryNumber("  +1234.56  ", numberFormat), { ok: true, value: 1234.56 });
    assert.deepEqual(parseMonetaryNumber(input.selected, numberFormat), { ok: true, value: 1234.56 });
    assert.deepEqual(parseMonetaryNumber(input.selectedNegative, numberFormat), { ok: true, value: -1234.56 });
    assert.deepEqual(parseMonetaryNumber(input.selectedUngrouped, numberFormat), { ok: true, value: 1234.56 });
  });
}

for (const numberFormat of ["1 234,56", "1 234.56"] as const) {
  const decimal = numberFormat === "1 234,56" ? "," : ".";

  test(`parseMonetaryNumber accepts clipboard space variants for ${numberFormat}`, (): void => {
    for (const group of ["\u0020", "\u00a0", "\u202f"]) {
      assert.deepEqual(
        parseMonetaryNumber(`1${group}234${decimal}56`, numberFormat),
        { ok: true, value: 1234.56 },
      );
    }
    assert.deepEqual(
      parseMonetaryNumber(`1\u0020234\u00a0567${decimal}89`, numberFormat),
      { ok: true, value: 1234567.89 },
    );
  });
}

test("parseMonetaryNumber gives canonical dot-decimal syntax precedence over dot grouping", (): void => {
  assert.deepEqual(parseMonetaryNumber("1.234", "1.234,56"), { ok: true, value: 1.234 });
  assert.deepEqual(parseMonetaryNumber("1234", "1.234,56"), { ok: true, value: 1234 });
  assert.deepEqual(parseMonetaryNumber("1.234,0", "1.234,56"), { ok: true, value: 1234 });
  assert.deepEqual(parseMonetaryNumber("1.234.567", "1.234,56"), { ok: true, value: 1234567 });
});

test("parseMonetaryNumber parses the complete space-grouped input instead of truncating it", (): void => {
  assert.deepEqual(parseMonetaryNumber("1 234.56", "1 234.56"), { ok: true, value: 1234.56 });
});

test("parseMonetaryNumberEdit preserves exact exponent-form initial values without accepting changed exponents", (): void => {
  for (const originalValue of [1e-7, -1e-7, 1e21, -1e21]) {
    const initialInput = String(originalValue);
    assert.match(initialInput, /e/);
    assert.deepEqual(
      parseMonetaryNumber(initialInput, "1,234.56"),
      { ok: false, reason: "invalid-format" },
    );
    assert.deepEqual(
      parseMonetaryNumberEdit(initialInput, originalValue, "1,234.56"),
      { ok: true, value: originalValue },
    );
  }

  assert.deepEqual(
    parseMonetaryNumberEdit("2e-7", 1e-7, "1,234.56"),
    { ok: false, reason: "invalid-format" },
  );
  assert.deepEqual(
    parseMonetaryNumberEdit("Infinity", Number.POSITIVE_INFINITY, "1,234.56"),
    { ok: false, reason: "invalid-format" },
  );
});

test("parseMonetaryNumber rejects malformed or unsupported syntax", (): void => {
  const invalidInputs: ReadonlyArray<Readonly<{ value: string; numberFormat: NumberFormat }>> = [
    { value: "12,34.56", numberFormat: "1,234.56" },
    { value: "1,23,456.78", numberFormat: "1,234.56" },
    { value: "1,234 567.89", numberFormat: "1,234.56" },
    { value: "12 34,56", numberFormat: "1 234,56" },
    { value: "1.23,45", numberFormat: "1.234,56" },
    { value: "1.234 567,89", numberFormat: "1.234,56" },
    { value: "12 34.56", numberFormat: "1 234.56" },
    { value: "1234.5.6", numberFormat: "1,234.56" },
    { value: "1234,5,6", numberFormat: "1.234,56" },
    { value: "1,234.56usd", numberFormat: "1,234.56" },
    { value: "NaN", numberFormat: "1,234.56" },
    { value: "Infinity", numberFormat: "1,234.56" },
    { value: "-Infinity", numberFormat: "1,234.56" },
    { value: "1e3", numberFormat: "1,234.56" },
    { value: "(1234.56)", numberFormat: "1,234.56" },
    { value: "$1234.56", numberFormat: "1,234.56" },
    { value: "+", numberFormat: "1,234.56" },
    { value: "-", numberFormat: "1,234.56" },
  ];

  for (const input of invalidInputs) {
    assert.deepEqual(
      parseMonetaryNumber(input.value, input.numberFormat),
      { ok: false, reason: "invalid-format" },
      input.value,
    );
  }

  assert.deepEqual(
    parseMonetaryNumber(" \t ", "1,234.56"),
    { ok: false, reason: "empty-input" },
  );
  assert.deepEqual(
    parseMonetaryNumber("9".repeat(400), "1,234.56"),
    { ok: false, reason: "non-finite" },
  );
});
