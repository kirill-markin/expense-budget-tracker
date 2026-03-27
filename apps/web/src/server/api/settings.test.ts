import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "./errors";
import { parseCreateWorkspaceBody, parseUserSettingsBody, parseWorkspaceSettingsBody } from "./settings";

test("parseUserSettingsBody rejects empty updates", () => {
  assert.throws(
    (): void => {
      parseUserSettingsBody({});
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "No fields to update",
  );
});

test("parseUserSettingsBody validates supported locale", () => {
  assert.throws(
    (): void => {
      parseUserSettingsBody({ locale: "de" });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid locale. Expected one of: en, ru, es, uk, fa, zh, ar, he",
  );
});

test("parseWorkspaceSettingsBody rejects empty updates", () => {
  assert.throws(
    (): void => {
      parseWorkspaceSettingsBody({});
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "No fields to update",
  );
});

test("parseWorkspaceSettingsBody validates reportingCurrency", () => {
  assert.throws(
    (): void => {
      parseWorkspaceSettingsBody({ reportingCurrency: "usd" });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid reportingCurrency. Expected 3-letter ISO 4217 code",
  );
});

test("parseWorkspaceSettingsBody validates filteredCategories", () => {
  assert.throws(
    (): void => {
      parseWorkspaceSettingsBody({ filteredCategories: [1] });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid filteredCategories. Expected array of strings or null",
  );
});

test("parseWorkspaceSettingsBody validates firstDayOfWeek", () => {
  assert.throws(
    (): void => {
      parseWorkspaceSettingsBody({ firstDayOfWeek: 8 });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid firstDayOfWeek. Expected integer 1-7",
  );
});

test("parseWorkspaceSettingsBody validates timezone", () => {
  assert.throws(
    (): void => {
      parseWorkspaceSettingsBody({ timezone: "" });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid timezone. Expected UTC or supported IANA timezone",
  );
});

test("parseWorkspaceSettingsBody accepts UTC timezone", () => {
  assert.deepEqual(parseWorkspaceSettingsBody({ timezone: "UTC" }), {
    reportingCurrency: undefined,
    filteredCategories: undefined,
    firstDayOfWeek: undefined,
    timezone: "UTC",
    hasReportingCurrency: false,
    hasFilteredCategories: false,
    hasFirstDayOfWeek: false,
    hasTimezone: true,
  });
});

test("parseCreateWorkspaceBody validates timezone", () => {
  assert.throws(
    (): void => {
      parseCreateWorkspaceBody({ name: "Trips", timezone: "Mars/Olympus" });
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "Invalid timezone. Expected UTC or supported IANA timezone",
  );
});

test("parseCreateWorkspaceBody trims name and accepts valid timezone", () => {
  assert.deepEqual(parseCreateWorkspaceBody({ name: " Trips ", timezone: "Europe/Madrid" }), {
    name: "Trips",
    timezone: "Europe/Madrid",
  });
});
