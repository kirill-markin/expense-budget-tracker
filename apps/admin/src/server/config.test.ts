import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAdminConfig } from "./config";

const LOCAL_ENV: Readonly<Record<string, string>> = {
  ADMIN_AUTH_MODE: "none",
  ADMIN_ORIGIN: "http://localhost:3001",
  ANALYTICS_EXCLUDED_EMAILS: " Demo@Example.com ",
  DATABASE_URL: "postgresql://unused@localhost:5432/unused",
};

describe("parseAdminConfig", () => {
  it("keeps lowercase ADMIN_EMAILS entries and trims surrounding whitespace", () => {
    const config = parseAdminConfig({ ...LOCAL_ENV, ADMIN_EMAILS: " admin@example.com , ops@example.com" });
    assert.deepEqual(config.adminEmails, ["admin@example.com", "ops@example.com"]);
  });

  it("rejects a mixed-case ADMIN_EMAILS entry", () => {
    assert.throws(
      () => parseAdminConfig({ ...LOCAL_ENV, ADMIN_EMAILS: "ops@example.com,Admin@Example.com" }),
      /ADMIN_EMAILS entry "Admin@Example.com" must be lowercase/,
    );
  });

  it("lowercases ANALYTICS_EXCLUDED_EMAILS", () => {
    const config = parseAdminConfig({ ...LOCAL_ENV, ADMIN_EMAILS: "admin@example.com" });
    assert.deepEqual(config.analyticsExcludedEmails, ["demo@example.com"]);
  });
});
