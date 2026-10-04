/**
 * Display mode of the budget table value columns.
 *
 * - "actuals": only the current month and the current year split into a Plan
 *   and an Actual column; every past month and past year shows its actual.
 * - "all-plans": every month and year up to the current one splits into a Plan
 *   and an Actual column, so historical plans stay visible next to the facts.
 */
export type BudgetPlansMode = "actuals" | "all-plans";

export const DEFAULT_BUDGET_PLANS_MODE: BudgetPlansMode = "actuals";

/** Query parameter of the budget page that selects the display mode. */
export const BUDGET_PLANS_MODE_QUERY_PARAM = "plans";

/**
 * Cookie carrying the last mode the user picked, read while the budget page
 * renders on the server so the first paint already holds the right columns.
 */
export const BUDGET_PLANS_MODE_COOKIE = "budget_plans";

/** The two values the query parameter and the cookie share. */
export const BUDGET_PLANS_MODE_VALUE_ALL = "all";
export const BUDGET_PLANS_MODE_VALUE_ACTUALS = "actuals";

/** Returns null for an absent value and for one this version does not define. */
export const parseBudgetPlansModeValue = (
  value: string | null,
): BudgetPlansMode | null => {
  if (value === BUDGET_PLANS_MODE_VALUE_ALL) return "all-plans";
  if (value === BUDGET_PLANS_MODE_VALUE_ACTUALS) return "actuals";
  return null;
};

/**
 * Resolves the mode the page renders in: an explicit query parameter wins over
 * the stored cookie, so a shared link always opens in the mode it names.
 */
export const resolveBudgetPlansMode = (
  queryValue: string | null,
  cookieValue: string | null,
): BudgetPlansMode => (
  parseBudgetPlansModeValue(queryValue)
  ?? parseBudgetPlansModeValue(cookieValue)
  ?? DEFAULT_BUDGET_PLANS_MODE
);

export const getBudgetPlansModeValue = (plansMode: BudgetPlansMode): string => (
  plansMode === "all-plans"
    ? BUDGET_PLANS_MODE_VALUE_ALL
    : BUDGET_PLANS_MODE_VALUE_ACTUALS
);

/** The default mode carries no query parameter, which keeps shared URLs clean. */
export const getBudgetPlansModeQueryValue = (
  plansMode: BudgetPlansMode,
): string | null => (
  plansMode === DEFAULT_BUDGET_PLANS_MODE ? null : getBudgetPlansModeValue(plansMode)
);

/**
 * First month a budget-grid read must return plan values for.
 *
 * "all-plans" renders a Plan column for every requested month, so the plan
 * window opens at the start of the requested range. "actuals" renders elapsed
 * months from their actual alone, so the current month stays the first planned
 * one and the read keeps the narrow window.
 */
export const getBudgetPlanFrom = (
  plansMode: BudgetPlansMode,
  monthFrom: string,
  currentMonth: string,
): string => (plansMode === "all-plans" ? monthFrom : currentMonth);

/**
 * Refresh token the budget data hooks follow.
 *
 * The mode is part of the token, so switching it refetches every loaded range
 * and every cached year total through the existing refresh path, with the plan
 * window the new mode needs.
 */
export const getBudgetRefreshToken = (
  refreshToken: string,
  plansMode: BudgetPlansMode,
): string => `${refreshToken}:${getBudgetPlansModeValue(plansMode)}`;

/**
 * Mode whose plan window every budget-grid range read must cover.
 *
 * The table renders the mode its loaded rows were fetched for, while the user
 * may already have requested the other one. Until that switch lands both
 * layouts can be on screen for the same rows, so a read covers whichever plan
 * window is the wider of the two and is therefore valid for both.
 *
 * Returning the wider window, never one single mode, is what makes a caller
 * reading a one-render-stale mode harmless: the result still covers the mode
 * that renders. Narrowing this to either argument alone would let an elapsed
 * Plan column read a plan the request never asked for, which renders as a zero
 * nobody planned. The invariant is pinned by a test in `plansMode.test.ts`.
 */
export const getBudgetRangeFetchPlansMode = (
  requestedPlansMode: BudgetPlansMode,
  loadedPlansMode: BudgetPlansMode,
): BudgetPlansMode => (
  requestedPlansMode === "all-plans" || loadedPlansMode === "all-plans"
    ? "all-plans"
    : "actuals"
);

/**
 * Mode the loaded rows answer for after a refresh settles.
 *
 * Only a refresh that landed its rows may publish the mode it fetched: a
 * failed or cancelled one leaves the previous mode in place, so the table
 * keeps rendering the fully loaded view it already shows instead of a layout
 * whose rows never arrived.
 */
export const getSettledBudgetPlansMode = (
  loadedPlansMode: BudgetPlansMode,
  refreshedPlansMode: BudgetPlansMode,
  didRefreshLand: boolean,
): BudgetPlansMode => (didRefreshLand ? refreshedPlansMode : loadedPlansMode);

/**
 * What the mode switcher has to say about the mode the user asked for.
 *
 * - "settled": the rendered mode is the requested one, so there is nothing to
 *   report.
 * - "refreshing": the requested mode is not on screen yet and the refresh that
 *   would bring it is running.
 * - "stuck": the requested mode is not on screen and no refresh is running, so
 *   nothing is going to bring it there on its own and only a retry will.
 */
export type BudgetPlansModeSwitchState = "settled" | "refreshing" | "stuck";

/**
 * Derives that report from the two facts that are true right now, never from
 * how an earlier refresh ended: a state that cannot be remembered cannot
 * outlive the request it describes, which is how a notice about a switch used
 * to stay on screen after the user had already asked for something else.
 *
 * A refresh that is only enqueued behind another one is not running either, so
 * the brief wait before it starts reads as "stuck"; the retry it offers then
 * merely enqueues the same refresh again, which is harmless.
 */
export const getBudgetPlansModeSwitchState = (
  requestedPlansMode: BudgetPlansMode,
  loadedPlansMode: BudgetPlansMode,
  isRangeRefreshing: boolean,
): BudgetPlansModeSwitchState => {
  if (requestedPlansMode === loadedPlansMode) {
    return "settled";
  }
  return isRangeRefreshing ? "refreshing" : "stuck";
};

/** A month that renders a Plan column next to its Actual column. */
export const isSplitBudgetMonth = (
  month: string,
  currentMonth: string,
  plansMode: BudgetPlansMode,
): boolean => (
  plansMode === "all-plans" ? month <= currentMonth : month === currentMonth
);

/** A year total that renders a Plan column next to its Actual column. */
export const isSplitBudgetYear = (
  year: string,
  currentYear: string,
  plansMode: BudgetPlansMode,
): boolean => (
  plansMode === "all-plans" ? year <= currentYear : year === currentYear
);
