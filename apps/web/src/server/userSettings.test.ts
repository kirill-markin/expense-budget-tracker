import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_USER_SETTINGS } from "@/lib/locale";

test("user settings read and persist lowercase per user, including disabling it", async (t): Promise<void> => {
  let rows: ReadonlyArray<unknown> = [];
  const calls: Array<Readonly<{
    userId: string;
    workspaceId: string;
    sql: string;
    params: ReadonlyArray<unknown>;
  }>> = [];

  t.mock.module("@/server/db", {
    namedExports: {
      queryAs: async (userId: string, workspaceId: string, sql: string, params: ReadonlyArray<unknown>) => {
        calls.push({ userId, workspaceId, sql, params });
        return { rows };
      },
    },
  });
  const { getUserSettings, updateUserSettings } = await import("./userSettings");

  assert.deepEqual(await getUserSettings("user-1", "workspace-1", "en"), DEFAULT_USER_SETTINGS);
  rows = [{
    locale: "en",
    number_format: "1,234.56",
    date_format: "YYYY-MM-DD",
    auto_filter_delay_minutes: 2,
    theme: "dark",
    lowercase: true,
  }];
  assert.equal((await getUserSettings("user-1", "workspace-1", "en")).lowercase, true);
  assert.match(calls.at(-1)!.sql, /SELECT .*lowercase FROM user_settings WHERE user_id = \$1/);

  for (const lowercase of [false, true]) {
    rows = [{ ...(rows[0] as Record<string, unknown>), lowercase }];
    const saved = await updateUserSettings("user-1", "workspace-2", { lowercase }, "en");
    assert.equal(saved.lowercase, lowercase);
    const call = calls.at(-1)!;
    assert.equal(call.userId, "user-1");
    assert.equal(call.workspaceId, "workspace-2");
    assert.deepEqual(call.params, ["user-1", lowercase]);
    assert.match(call.sql, /UPDATE user_settings SET lowercase = \$2 WHERE user_id = \$1 RETURNING .*lowercase/);
  }

  await updateUserSettings("user-1", "workspace-1", { theme: "light" }, "en");
  assert.doesNotMatch(calls.at(-1)!.sql.split("RETURNING")[0]!, /lowercase =/);
});
