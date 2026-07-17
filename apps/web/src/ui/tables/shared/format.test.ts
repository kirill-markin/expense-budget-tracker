import assert from "node:assert/strict";
import test from "node:test";

import type { NumberFormat } from "@/lib/locale";
import { formatAmount } from "@/ui/tables/shared/format";

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
