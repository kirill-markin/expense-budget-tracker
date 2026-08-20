import assert from "node:assert/strict";
import test from "node:test";

import { isValidTimezone, listSupportedTimezones, listTimezoneOptions } from "./timezone";

test("isValidTimezone accepts IANA zone names including link names", (): void => {
  for (const timezone of [
    "UTC",
    "GMT",
    "Europe/Madrid",
    "US/Pacific",
    "Asia/Calcutta",
    "Europe/Kiev",
    "Europe/Kyiv",
    "Etc/GMT+5",
  ]) {
    assert.equal(isValidTimezone(timezone), true, timezone);
  }
});

test("isValidTimezone rejects unusable values and numeric UTC offsets", (): void => {
  for (const timezone of ["Etc/Unknown", "+05:30", "-08:00", "05:30", "", "   ", "not a timezone"]) {
    assert.equal(isValidTimezone(timezone), false, timezone);
  }
});

test("listTimezoneOptions offers every stored spelling exactly once", (): void => {
  for (const timezone of ["US/Pacific", "Asia/Calcutta", "Asia/Kolkata", "Europe/Kiev", "Etc/GMT+5"]) {
    const options = listTimezoneOptions(timezone);

    assert.equal(options.includes(timezone), true, timezone);
    assert.equal(new Set(options).size, options.length, timezone);
  }
});

test("listTimezoneOptions keeps the supported list for a primary identifier", (): void => {
  assert.deepEqual(listTimezoneOptions("UTC"), listSupportedTimezones());
});
