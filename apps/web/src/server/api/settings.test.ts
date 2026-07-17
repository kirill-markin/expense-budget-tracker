import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "@/server/api/errors";
import { parseUserSettingsBody } from "@/server/api/settings";

test("parseUserSettingsBody accepts the space-dot number format", (): void => {
  const result = parseUserSettingsBody({ numberFormat: "1 234.56" });

  assert.equal(result.numberFormat, "1 234.56");
  assert.equal(result.hasNumberFormat, true);
  assert.equal(result.hasAutoFilterDelayMinutes, false);
});

test("parseUserSettingsBody rejects an unsupported number format", (): void => {
  assert.throws(
    () => parseUserSettingsBody({ numberFormat: "1_234.56" }),
    (error: unknown): boolean => {
      assert.ok(error instanceof ApiRouteError);
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, /^Invalid numberFormat\./);
      return true;
    },
  );
});

test("parseUserSettingsBody accepts supported auto filter delay values", (): void => {
  const supportedValues: ReadonlyArray<number> = [1, 2, 5, 10, 30];

  for (const value of supportedValues) {
    const result = parseUserSettingsBody({ autoFilterDelayMinutes: value });

    assert.equal(result.autoFilterDelayMinutes, value);
    assert.equal(result.hasAutoFilterDelayMinutes, true);
  }
});

test("parseUserSettingsBody accepts null auto filter delay", (): void => {
  const result = parseUserSettingsBody({ autoFilterDelayMinutes: null });

  assert.equal(result.autoFilterDelayMinutes, null);
  assert.equal(result.hasAutoFilterDelayMinutes, true);
});

test("parseUserSettingsBody preserves absent auto filter delay", (): void => {
  const result = parseUserSettingsBody({ dateFormat: "YYYY-MM-DD" });

  assert.equal(result.autoFilterDelayMinutes, undefined);
  assert.equal(result.hasAutoFilterDelayMinutes, false);
});

test("parseUserSettingsBody rejects unsupported auto filter delay values", (): void => {
  const invalidValues: ReadonlyArray<unknown> = [0, -1, 3, "2", true, { value: 2 }];

  for (const value of invalidValues) {
    assert.throws(
      () => parseUserSettingsBody({ autoFilterDelayMinutes: value }),
      (error: unknown): boolean => {
        assert.ok(error instanceof ApiRouteError);
        assert.equal(error.status, 400);
        assert.match(error.publicMessage, /^Invalid autoFilterDelayMinutes\./);
        return true;
      },
    );
  }
});
