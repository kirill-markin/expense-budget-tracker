import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "@/server/api/errors";
import { parseUserSettingsBody } from "@/server/api/settings";

test("parseUserSettingsBody accepts enabling and disabling lowercase", (): void => {
  for (const lowercase of [true, false]) {
    const result = parseUserSettingsBody({ lowercase });
    assert.equal(result.lowercase, lowercase);
    assert.equal(result.hasLowercase, true);
  }
});

test("parseUserSettingsBody preserves an absent lowercase preference", (): void => {
  const result = parseUserSettingsBody({ theme: "dark" });
  assert.equal(result.lowercase, undefined);
  assert.equal(result.hasLowercase, false);
});

test("parseUserSettingsBody rejects non-boolean lowercase preferences", (): void => {
  for (const lowercase of ["true", "false", 1, 0, null, {}]) {
    assert.throws(() => parseUserSettingsBody({ lowercase }), (error: unknown): boolean => {
      assert.ok(error instanceof ApiRouteError);
      assert.equal(error.status, 400);
      return true;
    });
  }
});

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
