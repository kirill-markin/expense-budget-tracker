import assert from "node:assert/strict";
import test from "node:test";

import {
  getBudgetPlanFrom,
  getBudgetPlansModeQueryValue,
  getBudgetPlansModeSwitchState,
  getBudgetPlansModeValue,
  getBudgetRangeFetchPlansMode,
  getBudgetRefreshToken,
  getSettledBudgetPlansMode,
  isSplitBudgetMonth,
  isSplitBudgetYear,
  parseBudgetPlansModeValue,
  resolveBudgetPlansMode,
  type BudgetPlansMode,
} from "@/ui/tables/budget/model/plansMode";

test("reads the mode from the query parameter before the cookie", (): void => {
  assert.equal(resolveBudgetPlansMode("all", "actuals"), "all-plans");
  assert.equal(resolveBudgetPlansMode("actuals", "all"), "actuals");
});

test("falls back to the cookie and then to the default mode", (): void => {
  assert.equal(resolveBudgetPlansMode(null, "all"), "all-plans");
  assert.equal(resolveBudgetPlansMode(null, "actuals"), "actuals");
  assert.equal(resolveBudgetPlansMode(null, null), "actuals");
});

test("ignores values this version does not define", (): void => {
  assert.equal(parseBudgetPlansModeValue("plans"), null);
  assert.equal(parseBudgetPlansModeValue(""), null);
  assert.equal(parseBudgetPlansModeValue(null), null);
  assert.equal(resolveBudgetPlansMode("everything", "all"), "all-plans");
  assert.equal(resolveBudgetPlansMode("everything", "nothing"), "actuals");
});

test("writes the cookie and the URL with the same vocabulary", (): void => {
  assert.equal(getBudgetPlansModeValue("all-plans"), "all");
  assert.equal(getBudgetPlansModeValue("actuals"), "actuals");
  assert.equal(getBudgetPlansModeQueryValue("all-plans"), "all");
  // The default mode carries no query parameter.
  assert.equal(getBudgetPlansModeQueryValue("actuals"), null);
  assert.equal(
    parseBudgetPlansModeValue(getBudgetPlansModeValue("all-plans")),
    "all-plans",
  );
  assert.equal(
    parseBudgetPlansModeValue(getBudgetPlansModeValue("actuals")),
    "actuals",
  );
});

test("opens the plan window at the requested range in the all-plans mode", (): void => {
  assert.equal(getBudgetPlanFrom("all-plans", "2026-04", "2026-10"), "2026-04");
  assert.equal(getBudgetPlanFrom("all-plans", "2027-01", "2026-10"), "2027-01");
});

test("keeps the current month as the plan window in the default mode", (): void => {
  assert.equal(getBudgetPlanFrom("actuals", "2026-04", "2026-10"), "2026-10");
  assert.equal(getBudgetPlanFrom("actuals", "2027-01", "2026-10"), "2026-10");
});

test("refetches every range and year total only when the mode changes", (): void => {
  assert.equal(getBudgetRefreshToken("token", "actuals"), "token:actuals");
  assert.equal(getBudgetRefreshToken("token", "all-plans"), "token:all");
  assert.notEqual(
    getBudgetRefreshToken("token", "actuals"),
    getBudgetRefreshToken("token", "all-plans"),
  );
  assert.equal(
    getBudgetRefreshToken("token", "all-plans"),
    getBudgetRefreshToken("token", "all-plans"),
  );
});

test("reads a range with the wider plan window while a switch is pending", (): void => {
  // Either side asking for historical plans makes the read cover them, so the
  // same rows render correctly in the loaded layout and in the requested one.
  assert.equal(getBudgetRangeFetchPlansMode("all-plans", "actuals"), "all-plans");
  assert.equal(getBudgetRangeFetchPlansMode("actuals", "all-plans"), "all-plans");
  assert.equal(getBudgetRangeFetchPlansMode("all-plans", "all-plans"), "all-plans");
  assert.equal(getBudgetRangeFetchPlansMode("actuals", "actuals"), "actuals");
});

test("covers the plan window of both modes whichever one renders", (): void => {
  // The invariant the publish contract rests on: the fetched window opens no
  // later than the window either mode needs, so a caller that reads one of
  // them a render late still gets rows covering the layout on screen. A future
  // change returning a single mode would break this and let an elapsed Plan
  // column render a zero nobody planned.
  const modes: ReadonlyArray<BudgetPlansMode> = ["actuals", "all-plans"];
  const monthFrom = "2026-04";
  const currentMonth = "2026-10";
  for (const requestedPlansMode of modes) {
    for (const loadedPlansMode of modes) {
      const fetchedPlanFrom = getBudgetPlanFrom(
        getBudgetRangeFetchPlansMode(requestedPlansMode, loadedPlansMode),
        monthFrom,
        currentMonth,
      );
      for (const renderedPlansMode of [requestedPlansMode, loadedPlansMode]) {
        assert.ok(
          fetchedPlanFrom <= getBudgetPlanFrom(
            renderedPlansMode,
            monthFrom,
            currentMonth,
          ),
          `fetched plan window ${fetchedPlanFrom} must cover ${renderedPlansMode}`,
        );
      }
    }
  }
});

test("splits elapsed months and years only in the all-plans mode", (): void => {
  assert.equal(isSplitBudgetMonth("2026-04", "2026-10", "all-plans"), true);
  assert.equal(isSplitBudgetMonth("2026-10", "2026-10", "all-plans"), true);
  assert.equal(isSplitBudgetMonth("2026-11", "2026-10", "all-plans"), false);
  assert.equal(isSplitBudgetMonth("2026-04", "2026-10", "actuals"), false);
  assert.equal(isSplitBudgetMonth("2026-10", "2026-10", "actuals"), true);

  assert.equal(isSplitBudgetYear("2025", "2026", "all-plans"), true);
  assert.equal(isSplitBudgetYear("2026", "2026", "all-plans"), true);
  assert.equal(isSplitBudgetYear("2027", "2026", "all-plans"), false);
  assert.equal(isSplitBudgetYear("2025", "2026", "actuals"), false);
  assert.equal(isSplitBudgetYear("2026", "2026", "actuals"), true);
});

test("publishes the refreshed mode only once its rows landed", (): void => {
  assert.equal(
    getSettledBudgetPlansMode("actuals", "all-plans", true),
    "all-plans",
  );
  assert.equal(
    getSettledBudgetPlansMode("all-plans", "actuals", true),
    "actuals",
  );
});

test("keeps the loaded mode when a refresh failed or was cancelled", (): void => {
  // A widening refresh that never landed must not publish "all-plans": the
  // rows in state still hold the narrow plan window, so every elapsed Plan
  // column would otherwise render a zero nobody planned. The table keeps
  // rendering the mode it has, which stays fully loaded.
  assert.equal(
    getSettledBudgetPlansMode("actuals", "all-plans", false),
    "actuals",
  );
  assert.equal(
    getSettledBudgetPlansMode("all-plans", "actuals", false),
    "all-plans",
  );
});

test("reports nothing about a mode that is already on screen", (): void => {
  // Including while an unrelated refresh of the loaded range runs: the control
  // is disabled from that signal on its own, and no notice belongs here.
  assert.equal(getBudgetPlansModeSwitchState("actuals", "actuals", false), "settled");
  assert.equal(getBudgetPlansModeSwitchState("actuals", "actuals", true), "settled");
  assert.equal(
    getBudgetPlansModeSwitchState("all-plans", "all-plans", true),
    "settled",
  );
});

test("reports a pending switch as refreshing while its refresh runs", (): void => {
  assert.equal(
    getBudgetPlansModeSwitchState("all-plans", "actuals", true),
    "refreshing",
  );
  assert.equal(
    getBudgetPlansModeSwitchState("actuals", "all-plans", true),
    "refreshing",
  );
});

test("reports a pending switch with nothing running as stuck", (): void => {
  // However the refresh ended - failed, superseded, or cancelled before its
  // first attempt - the mode the user asked for is off screen and no run is
  // going to put it there, which is the only state the retry belongs to.
  assert.equal(
    getBudgetPlansModeSwitchState("all-plans", "actuals", false),
    "stuck",
  );
  assert.equal(
    getBudgetPlansModeSwitchState("actuals", "all-plans", false),
    "stuck",
  );
});
