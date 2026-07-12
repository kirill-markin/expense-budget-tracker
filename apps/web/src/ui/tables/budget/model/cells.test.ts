import assert from "node:assert/strict";
import test from "node:test";

import { formatSignedAmount } from "@/ui/tables/budget/model/cells";

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
