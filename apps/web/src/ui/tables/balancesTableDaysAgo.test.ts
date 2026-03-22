import assert from "node:assert/strict";
import test from "node:test";

import { compareDaysAgoTimestamps, formatDaysAgoLabel, getDaysAgoValue } from "./balancesTableDaysAgo";

const translate = (key: string, opts?: Record<string, string | number>): string => {
  if (key === "balances.daysAgoToday") return "today";
  if (key === "balances.daysAgoOne") return "1 day ago";
  if (key === "balances.daysAgoMany") return `${String(opts?.count)} days ago`;
  throw new Error(`Unexpected translation key: ${key}`);
};

test("getDaysAgoValue clamps future timestamps on the same day to today", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const days = getDaysAgoValue("2026-03-22T12:00:00.000Z", now);

  assert.equal(days, 0);
  assert.equal(formatDaysAgoLabel(days, translate), "today");
});

test("getDaysAgoValue returns today for an exact timestamp match", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const days = getDaysAgoValue("2026-03-22T10:00:00.000Z", now);

  assert.equal(days, 0);
  assert.equal(formatDaysAgoLabel(days, translate), "today");
});

test("getDaysAgoValue returns one day ago for yesterday", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const days = getDaysAgoValue("2026-03-21T09:00:00.000Z", now);

  assert.equal(days, 1);
  assert.equal(formatDaysAgoLabel(days, translate), "1 day ago");
});

test("getDaysAgoValue returns many days ago for older transactions", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const days = getDaysAgoValue("2026-03-17T08:00:00.000Z", now);

  assert.equal(days, 5);
  assert.equal(formatDaysAgoLabel(days, translate), "5 days ago");
});

test("getDaysAgoValue clamps future timestamps on a later day to today", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const days = getDaysAgoValue("2026-03-23T00:00:00.000Z", now);

  assert.equal(days, 0);
  assert.equal(formatDaysAgoLabel(days, translate), "today");
});

test("compareDaysAgoTimestamps sorts by normalized days ago instead of raw timestamp text", () => {
  const now = new Date("2026-03-22T10:00:00.000Z");

  const cmp = compareDaysAgoTimestamps(
    "2026-03-23T00:00:00.000Z",
    "2026-03-21T09:00:00.000Z",
    now,
  );

  assert.equal(cmp < 0, true);
});
