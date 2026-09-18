import assert from "node:assert/strict";
import test from "node:test";
import { createQueryResult } from "../handlerTestUtils.js";
import { ALLOWED_RELATION_NAMES, loadAllowedSchemaWithResolver } from "./schemaService.js";
import type { MachineApiDependencies } from "./types.js";

test("machine API schema allowlist excludes internal and removed relations", (): void => {
  const relationNames: ReadonlyArray<string> = ALLOWED_RELATION_NAMES;
  assert.equal(relationNames.includes("monthly_category_shares"), false);
  assert.equal(relationNames.includes("monthly_category_share_items"), false);
  assert.equal(relationNames.includes("monthly_category_share_keys"), false);
  assert.equal(relationNames.includes("budget_comments"), false);
});

test("loadAllowedSchema resolves a real workspace context before querying", async (): Promise<void> => {
  const identity = {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  };
  const contextWorkspaceId = "workspace-1";
  let queryWorkspaceId: string | null = null;

  const dependencies: MachineApiDependencies = {
    ensureTrustedIdentityProvisioned: async () => undefined,
    log: () => {
      throw new Error("log should not be called");
    },
    queryAsTrustedIdentity: async (_identity, workspaceId) => {
      queryWorkspaceId = workspaceId;
      return createQueryResult([]);
    },
    queryAsTrustedIdentityBeforeDeadline: async () => {
      throw new Error("queryAsTrustedIdentityBeforeDeadline should not be called");
    },
    resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline: async () => {
      throw new Error("resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline should not be called");
    },
    withReadOnlyRestrictedTrustedIdentityContext: async () => {
      throw new Error("withReadOnlyRestrictedTrustedIdentityContext should not be called");
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("withRestrictedTrustedIdentityContext should not be called");
    },
  };

  const schema = await loadAllowedSchemaWithResolver(
    dependencies,
    identity,
    async () => ({ workspaceId: contextWorkspaceId, created: false }),
  );

  assert.equal(queryWorkspaceId, contextWorkspaceId);
  assert.notEqual(queryWorkspaceId, identity.userId);
  const ledgerHints = schema.find((relation) => relation.name === "ledger_entries")?.hints;
  assert.equal(ledgerHints?.optional, false);
  assert.deepEqual(ledgerHints?.primaryKey, ["entry_id"]);
  assert.equal((ledgerHints?.notes ?? []).length > 0, true);
  assert.deepEqual(
    ledgerHints?.columnConstraints,
    [{
      column: "kind",
      allowedValues: ["income", "spend", "transfer"],
      notes: ["Only income, spend, or transfer are accepted."],
    }],
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "accounts")?.hints,
    {
      summary: "Derived account list built from ledger entries.",
      related: ["ledger_entries", "account_metadata", "workspace_settings"],
      optional: false,
      notes: [
        "SELECT-only derived view. Do not INSERT, UPDATE, or DELETE.",
        "currency is the most frequent currency across the account's entries rather than a declared account currency, and inserted_at is the earliest insertion time of its entries.",
      ],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "budget_lines")?.hints,
    {
      summary: "Monthly Base budget rows, one row per budget month, direction, and category.",
      related: ["budget_adjustments", "workspace_settings"],
      optional: false,
      notes: [
        "Exactly one row per budget_month, direction, and category: UPDATE that row to change a plan, INSERT to create the first one, and DELETE it to remove the plan, because planned_value can never be zero.",
        "budget_lines carries only the Base plan. The budget the app displays adds the matching budget_adjustments rows, so a planned_value read or written here can differ from the value the user sees.",
      ],
      columnConstraints: [
        {
          column: "direction",
          allowedValues: ["income", "spend"],
          notes: ["The budget model uses only income and spend. A CHECK constraint rejects writing any other value."],
        },
      ],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "budget_adjustments")?.hints,
    {
      summary: "Monthly budget adjustments the app adds on top of the Base plan in budget_lines.",
      related: ["budget_lines", "workspace_settings"],
      optional: false,
      primaryKey: ["adjustment_id"],
      notes: [
        "Edited through the app and, under existing write-approval rules, with INSERT, UPDATE, and DELETE here; workspace_id must be set explicitly on every INSERT, read it from workspace_settings.",
        "INSERT may name only workspace_id, budget_month, direction, category, amount, and note, and UPDATE only budget_month, direction, category, amount, and note; adjustment_id, created_at, and updated_at are generated and workspace_id never changes, so naming one of them fails with a permission error that names the table instead of the offending column.",
        "budget_month is the first day of the month, for example 2026-03-01; amount is a whole number between -9007199254740991 and 9007199254740991; category is 1 to 200 characters; note is at most 2000 characters. CHECK constraints reject any other value.",
        "One row per adjustment; several rows can share one budget_month, direction, and category.",
        "The plan the app displays for a budget_month, direction, and category is the budget_lines planned_value plus SUM(amount) of the matching rows here, counting a missing side as 0 and converting no currency.",
        "origin is an internal column these tools can neither read nor write, so SELECT * and any reference to origin fail with a permission error; list the columns explicitly and let an inserted row take its default origin.",
      ],
      columnConstraints: [{
        column: "direction",
        allowedValues: ["income", "spend"],
        notes: ["The budget model uses only income and spend. A CHECK constraint rejects writing any other value."],
      }],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "fx_rates_raw")?.hints,
    {
      summary: "Canonical raw FX source rates against the internal USD pivot currency.",
      related: ["fx_rates_daily", "workspace_settings", "ledger_entries"],
      optional: false,
      notes: [
        "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
      ],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "fx_rates_daily")?.hints,
    {
      summary: "Query-ready daily all-pairs FX rates used by dashboards and reporting-currency conversion.",
      related: ["fx_rates_raw", "workspace_settings", "ledger_entries"],
      optional: false,
      notes: [
        "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
      ],
    },
  );
});
