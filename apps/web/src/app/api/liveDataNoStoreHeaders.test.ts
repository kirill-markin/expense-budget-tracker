import assert from "node:assert/strict";
import test from "node:test";

import { GET as getBalancesSummary } from "@/app/api/balances-summary/route";
import { GET as getBudgetComment } from "@/app/api/budget-comment/route";
import { GET as getBudgetCommentsExist } from "@/app/api/budget-comments-exist/route";
import { GET as getBudgetGrid } from "@/app/api/budget-grid/route";
import { GET as getFxBreakdown } from "@/app/api/fx-breakdown/route";
import { GET as getTransactions } from "@/app/api/transactions/route";

const assertNoStoreHeaders = (response: Response): void => {
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("Expires"), "0");
};

test("live workspace GET endpoints return no-store headers in demo mode", async () => {
  const demoHeaders = { cookie: "demo=true" };

  const responses = await Promise.all([
    getTransactions(new Request("http://localhost/api/transactions?dateFrom=2026-01-01&dateTo=2026-03-31&sortKey=ts&sortDir=desc&limit=100&offset=0", { headers: demoHeaders })),
    getBudgetGrid(new Request("http://localhost/api/budget-grid?monthFrom=2026-01&monthTo=2026-03&planFrom=2026-01&actualTo=2026-03", { headers: demoHeaders })),
    getFxBreakdown(new Request("http://localhost/api/fx-breakdown?month=2026-03", { headers: demoHeaders })),
    getBudgetComment(new Request("http://localhost/api/budget-comment?month=2026-03&direction=spend&category=Food", { headers: demoHeaders })),
    getBudgetCommentsExist(new Request("http://localhost/api/budget-comments-exist?monthFrom=2026-01&monthTo=2026-03", { headers: demoHeaders })),
    getBalancesSummary(new Request("http://localhost/api/balances-summary", { headers: demoHeaders })),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 200);
    assertNoStoreHeaders(response);
  }
});
