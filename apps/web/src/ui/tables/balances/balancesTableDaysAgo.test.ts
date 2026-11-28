import assert from "node:assert/strict";
import test from "node:test";

import { initI18n } from "@/i18n/i18nConfig";
import { getMessages } from "@/i18n/serverT";

import { formatDaysAgoLabel } from "./balancesTableDaysAgo";

test("balance age keeps today distinct and selects the locale's plural form", (): void => {
  const russian = initI18n("ru", getMessages("ru"));
  const arabic = initI18n("ar", getMessages("ar"));

  assert.equal(formatDaysAgoLabel(0, russian.t), "сегодня");
  assert.equal(formatDaysAgoLabel(1, russian.t), "1 день назад");
  assert.equal(formatDaysAgoLabel(21, russian.t), "21 день назад");
  assert.equal(formatDaysAgoLabel(5, russian.t), "5 дней назад");
  assert.equal(formatDaysAgoLabel(1, arabic.t), "منذ يوم واحد");
});
