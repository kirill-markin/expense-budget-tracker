import assert from "node:assert/strict";
import test from "node:test";

import { formatSignedAmount } from "@/ui/tables/budget/model/cells";
import { formatFxAmount } from "@/ui/tables/fx/format";

test("formatSignedAmount formats signed rounded integers", (): void => {
  assert.equal(formatSignedAmount(42.4, "1,234.56"), "+42");
  assert.equal(formatSignedAmount(-42.4, "1,234.56"), "-42");
  assert.equal(formatSignedAmount(0, "1,234.56"), "0");
  assert.equal(formatSignedAmount(0.4, "1,234.56"), "0");
  assert.equal(formatSignedAmount(-0.4, "1,234.56"), "0");
});

test("formatSignedAmount uses the selected thousands separator", (): void => {
  assert.equal(formatSignedAmount(12_345.4, "1.234,56"), "+12.345");
});

test("formatSignedAmount supports ordinary-space grouping", (): void => {
  assert.equal(formatSignedAmount(12_345.4, "1 234.56"), "+12 345");
  assert.equal(formatSignedAmount(-12_345.4, "1 234.56"), "-12 345");
});

test("formatFxAmount preserves its inverted sign with ordinary-space grouping", (): void => {
  assert.equal(formatFxAmount(-12_345.4, "1 234.56"), "+12 345");
  assert.equal(formatFxAmount(12_345.4, "1 234.56"), "-12 345");
  assert.equal(formatFxAmount(0.4, "1 234.56"), "0");
});
