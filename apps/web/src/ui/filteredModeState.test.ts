import assert from "node:assert/strict";
import test from "node:test";

import {
  getAutoFilterDelayMs,
  getRemainingDelayMs,
  parseStoredLastActiveAt,
  parseStoredVisibilityMode,
  resolveManualModeTimerDecision,
  resolvePolicyChangeTimerDecision,
  resolveStoredVisibilityMode,
  resolveVisibleTimerDecision,
} from "@/ui/filteredModeState";

const NOW_MS = 1_000_000;
const TWO_MINUTES_MS = 2 * 60 * 1000;

test("parseStoredVisibilityMode accepts only saved manual modes", (): void => {
  assert.equal(parseStoredVisibilityMode("all"), "all");
  assert.equal(parseStoredVisibilityMode("filtered"), "filtered");
  assert.equal(parseStoredVisibilityMode("demo"), null);
  assert.equal(parseStoredVisibilityMode(""), null);
  assert.equal(parseStoredVisibilityMode(null), null);
});

test("parseStoredLastActiveAt accepts finite non-negative timestamps", (): void => {
  assert.equal(parseStoredLastActiveAt("0"), 0);
  assert.equal(parseStoredLastActiveAt("12345"), 12345);
  assert.equal(parseStoredLastActiveAt(null), null);
  assert.equal(parseStoredLastActiveAt(""), null);
  assert.equal(parseStoredLastActiveAt("-1"), null);
  assert.equal(parseStoredLastActiveAt("Infinity"), null);
  assert.equal(parseStoredLastActiveAt("not-a-number"), null);
});

test("resolveStoredVisibilityMode restores disabled automation without timestamp expiry", (): void => {
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: String(NOW_MS - TWO_MINUTES_MS * 10),
      autoFilterDelayMinutes: null,
      nowMs: NOW_MS,
    }),
    "all",
  );
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "filtered",
      storedLastActiveAt: null,
      autoFilterDelayMinutes: null,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: null,
      storedLastActiveAt: null,
      autoFilterDelayMinutes: null,
      nowMs: NOW_MS,
    }),
    "all",
  );
});

test("resolveStoredVisibilityMode keeps enabled first use privacy-safe", (): void => {
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: null,
      storedLastActiveAt: null,
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
});

test("resolveStoredVisibilityMode restores enabled all mode only before the boundary", (): void => {
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: String(NOW_MS - TWO_MINUTES_MS + 1),
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "all",
  );
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: String(NOW_MS - TWO_MINUTES_MS),
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: String(NOW_MS - TWO_MINUTES_MS - 1),
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
});

test("resolveStoredVisibilityMode rejects enabled all mode without a valid timestamp", (): void => {
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: null,
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "all",
      storedLastActiveAt: "not-a-number",
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
});

test("resolveStoredVisibilityMode always restores enabled filtered mode", (): void => {
  assert.equal(
    resolveStoredVisibilityMode({
      storedMode: "filtered",
      storedLastActiveAt: "not-a-number",
      autoFilterDelayMinutes: 2,
      nowMs: NOW_MS,
    }),
    "filtered",
  );
});

test("getRemainingDelayMs uses explicit wall-clock comparison semantics", (): void => {
  assert.equal(
    getRemainingDelayMs({
      delayMs: TWO_MINUTES_MS,
      lastActiveAt: NOW_MS - 30_000,
      nowMs: NOW_MS,
    }),
    90_000,
  );
  assert.equal(
    getRemainingDelayMs({
      delayMs: TWO_MINUTES_MS,
      lastActiveAt: NOW_MS - TWO_MINUTES_MS,
      nowMs: NOW_MS,
    }),
    0,
  );
  assert.equal(
    getRemainingDelayMs({
      delayMs: TWO_MINUTES_MS,
      lastActiveAt: NOW_MS + 30_000,
      nowMs: NOW_MS,
    }),
    TWO_MINUTES_MS,
  );
});

test("resolveVisibleTimerDecision arms remaining time or expires on wall-clock boundary", (): void => {
  assert.deepEqual(
    resolveVisibleTimerDecision({
      autoFilterDelayMinutes: 2,
      visibilityMode: "all",
      lastActiveAt: NOW_MS - 30_000,
      nowMs: NOW_MS,
    }),
    { kind: "arm", delayMs: 90_000, lastActiveAt: NOW_MS - 30_000 },
  );
  assert.deepEqual(
    resolveVisibleTimerDecision({
      autoFilterDelayMinutes: 2,
      visibilityMode: "all",
      lastActiveAt: NOW_MS - TWO_MINUTES_MS,
      nowMs: NOW_MS,
    }),
    { kind: "switchToFiltered" },
  );
  assert.deepEqual(
    resolveVisibleTimerDecision({
      autoFilterDelayMinutes: 2,
      visibilityMode: "all",
      lastActiveAt: null,
      nowMs: NOW_MS,
    }),
    { kind: "switchToFiltered" },
  );
  assert.deepEqual(
    resolveVisibleTimerDecision({
      autoFilterDelayMinutes: null,
      visibilityMode: "all",
      lastActiveAt: NOW_MS - TWO_MINUTES_MS,
      nowMs: NOW_MS,
    }),
    { kind: "cancel" },
  );
});

test("resolvePolicyChangeTimerDecision cancels null and starts a fresh full interval for all mode", (): void => {
  assert.deepEqual(
    resolvePolicyChangeTimerDecision({
      autoFilterDelayMinutes: null,
      visibilityMode: "all",
      nowMs: NOW_MS,
    }),
    { kind: "cancel" },
  );
  assert.deepEqual(
    resolvePolicyChangeTimerDecision({
      autoFilterDelayMinutes: 10,
      visibilityMode: "all",
      nowMs: NOW_MS,
    }),
    { kind: "arm", delayMs: getAutoFilterDelayMs(10), lastActiveAt: NOW_MS },
  );
  assert.deepEqual(
    resolvePolicyChangeTimerDecision({
      autoFilterDelayMinutes: 10,
      visibilityMode: "filtered",
      nowMs: NOW_MS,
    }),
    { kind: "cancel" },
  );
});

test("resolveManualModeTimerDecision cancels filtered and arms all only when enabled", (): void => {
  assert.deepEqual(
    resolveManualModeTimerDecision({
      autoFilterDelayMinutes: 5,
      visibilityMode: "filtered",
      nowMs: NOW_MS,
    }),
    { kind: "cancel" },
  );
  assert.deepEqual(
    resolveManualModeTimerDecision({
      autoFilterDelayMinutes: null,
      visibilityMode: "all",
      nowMs: NOW_MS,
    }),
    { kind: "cancel" },
  );
  assert.deepEqual(
    resolveManualModeTimerDecision({
      autoFilterDelayMinutes: 5,
      visibilityMode: "all",
      nowMs: NOW_MS,
    }),
    { kind: "arm", delayMs: getAutoFilterDelayMs(5), lastActiveAt: NOW_MS },
  );
});
