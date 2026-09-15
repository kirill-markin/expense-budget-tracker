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
  assert.equal(relationNames.includes("budget_adjustments"), false);
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
      summary: "Append-only monthly Base budget rows with last-write-wins semantics.",
      related: ["workspace_settings"],
      optional: false,
      notes: [
        "Append-only Base budget rows. The latest inserted_at value wins for each budget_month, direction, and category.",
        "budget_lines carries only the Base plan. The budget the app displays is that plan plus a separate budget_adjustments component these tools cannot read or write, so a planned_value read or written here can differ from the value the user sees.",
      ],
      columnConstraints: [
        {
          column: "kind",
          allowedValues: ["base"],
          notes: ["Only base is accepted."],
        },
        {
          column: "direction",
          allowedValues: ["income", "spend"],
          notes: ["The budget model uses only income and spend. The column carries no CHECK, so any other value is stored silently and corrupts budget reporting; never write one."],
        },
      ],
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
