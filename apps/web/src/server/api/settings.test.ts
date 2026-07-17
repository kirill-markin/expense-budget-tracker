import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "@/server/api/errors";
import { parseUserSettingsBody } from "@/server/api/settings";

test("parseUserSettingsBody accepts the space-dot number format", (): void => {
  const result = parseUserSettingsBody({ numberFormat: "1 234.56" });

  assert.equal(result.numberFormat, "1 234.56");
  assert.equal(result.hasNumberFormat, true);
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
