import assert from "node:assert/strict";
import test from "node:test";

import { getDemoBudgetAdjustments, getDemoCategories, getDemoTransactionsPage } from "@/server/demo/data";
import type { TransactionsFilter } from "@/server/transactions/getTransactions";

import { formatCategoryLabel } from "./demoLabels";
import { initI18n } from "./i18nConfig";
import { getMessages } from "./serverT";

test("demo labels use catalog text without changing canonical transaction filters", (): void => {
  const canonicalCategory = "Groceries";
  const translatedCategory = "Comestibles";
  const i18n = initI18n("es", { ...getMessages("es"), "demo.category.groceries": translatedCategory });
  const filter: TransactionsFilter = {
    dateFrom: null,
    dateTo: null,
    accountId: null,
    accountIds: null,
    kind: null,
    kinds: null,
    currencies: null,
    category: canonicalCategory,
    categories: null,
    counterparties: null,
    businessPersonalTransfers: false,
    sortKey: "ts",
    sortDir: "desc",
    limit: 2,
    offset: 0,
  };

  const result = getDemoTransactionsPage(filter);
  assert.ok(result.total > 0);
  for (const entry of result.entries) {
    assert.equal(entry.category, canonicalCategory);
    assert.equal(formatCategoryLabel(entry.category, true, i18n.t), translatedCategory);
  }
  assert.equal(getDemoTransactionsPage({ ...filter, category: translatedCategory }).total, 0);
  assert.equal(formatCategoryLabel(canonicalCategory, false, i18n.t), canonicalCategory);
  assert.equal(formatCategoryLabel("Custom 旅行", true, i18n.t), "Custom 旅行");
});

test("each authored ledger or adjustment category has a catalog key", (): void => {
  const categories = new Set([
    ...getDemoCategories(),
    ...getDemoBudgetAdjustments().map((adjustment) => adjustment.category),
  ]);

  for (const category of categories) {
    const key = formatCategoryLabel(category, true, (messageKey): string => messageKey);
    assert.match(key, /^demo\.category\./);
    assert.ok(Object.hasOwn(getMessages("en"), key), key);
  }
});
