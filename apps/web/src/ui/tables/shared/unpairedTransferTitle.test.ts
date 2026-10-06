import assert from "node:assert/strict";
import test from "node:test";

import type { UnpairedTransferLeg } from "@/server/budget/getBudgetGrid";
import { buildUnpairedTransferLegsTitle } from "@/ui/tables/shared/unpairedTransferTitle";

const HEADING = "one-legged transfer";

const leg = (index: number): UnpairedTransferLeg => ({
  date: `2026-03-${String(index).padStart(2, "0")}`,
  accountId: `account-${index}`,
  amount: -index,
  currency: "EUR",
});

const formatLeg = (value: UnpairedTransferLeg): string =>
  `${value.date} ${value.accountId} ${value.amount} ${value.currency}`;

const formatHiddenCount = (count: number): string => `+${count} more`;

const buildTitle = (legCount: number): string | null => buildUnpairedTransferLegsTitle(
  Array.from({ length: legCount }, (_, index) => leg(index + 1)),
  HEADING,
  formatLeg,
  formatHiddenCount,
);

test("buildUnpairedTransferLegsTitle returns no reason without legs", (): void => {
  assert.equal(buildTitle(0), null);
});

test("buildUnpairedTransferLegsTitle lists every leg below the heading", (): void => {
  assert.equal(
    buildTitle(2),
    [HEADING, "2026-03-01 account-1 -1 EUR", "2026-03-02 account-2 -2 EUR"].join("\n"),
  );
});

test("buildUnpairedTransferLegsTitle lists five legs without a collapse line", (): void => {
  const title = buildTitle(5);

  assert.equal(title?.split("\n").length, 6);
  assert.equal(title?.includes("more"), false);
  assert.equal(title?.endsWith("2026-03-05 account-5 -5 EUR"), true);
});

test("buildUnpairedTransferLegsTitle collapses the legs past the fifth into one line", (): void => {
  const title = buildTitle(8);

  assert.equal(
    title,
    [
      HEADING,
      "2026-03-01 account-1 -1 EUR",
      "2026-03-02 account-2 -2 EUR",
      "2026-03-03 account-3 -3 EUR",
      "2026-03-04 account-4 -4 EUR",
      "2026-03-05 account-5 -5 EUR",
      "+3 more",
    ].join("\n"),
  );
});
