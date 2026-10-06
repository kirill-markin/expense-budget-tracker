import assert from "node:assert/strict";
import test from "node:test";

import { resolveYearTotalStateTokens } from "@/ui/tables/budget/table/sections/yearTotalState";

test("a trusted value inside its plan carries no state", (): void => {
  assert.deepEqual(resolveYearTotalStateTokens(false, false), []);
});

test("an untrusted value takes the warning colour and the warning background", (): void => {
  assert.deepEqual(resolveYearTotalStateTokens(true, false), ["warning", "warningBackground"]);
});

test("an over value takes the danger colour and the danger background", (): void => {
  assert.deepEqual(resolveYearTotalStateTokens(false, true), ["over", "danger"]);
});

test("red wins over yellow when a value is both untrusted and over", (): void => {
  assert.deepEqual(resolveYearTotalStateTokens(true, true), ["warning", "over", "danger"]);
});
