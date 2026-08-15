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
  assert.deepEqual(
    schema.find((relation) => relation.name === "accounts")?.hints,
    {
      optional: false,
      notes: [
        "SELECT-only derived view. Do not INSERT, UPDATE, or DELETE.",
      ],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "budget_lines")?.hints,
    {
      optional: false,
      notes: [
        "Append-only Base budget rows. The latest inserted_at value wins for each budget_month, direction, and category.",
      ],
      columnConstraints: [{
        column: "kind",
        allowedValues: ["base"],
        notes: ["Only base is accepted."],
      }],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "fx_rates_raw")?.hints,
    {
      optional: false,
      notes: [
        "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
      ],
    },
  );
  assert.deepEqual(
    schema.find((relation) => relation.name === "fx_rates_daily")?.hints,
    {
      optional: false,
      notes: [
        "SELECT-only global relation maintained by the FX worker. Do not INSERT, UPDATE, or DELETE.",
      ],
    },
  );
});
