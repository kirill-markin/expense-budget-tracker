import assert from "node:assert/strict";
import test from "node:test";
import { createQueryResult } from "../handlerTestUtils.js";
import { loadAllowedSchemaWithResolver } from "./schemaService.js";
import type { MachineApiDependencies } from "./types.js";

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
    loadOpenApiDocument: () => ({}),
    queryAsTrustedIdentity: async (_identity, workspaceId) => {
      queryWorkspaceId = workspaceId;
      return createQueryResult([]);
    },
    withRestrictedTrustedIdentityContext: async () => {
      throw new Error("withRestrictedTrustedIdentityContext should not be called");
    },
  };

  await loadAllowedSchemaWithResolver(
    dependencies,
    identity,
    async () => ({ workspaceId: contextWorkspaceId, created: false }),
  );

  assert.equal(queryWorkspaceId, contextWorkspaceId);
  assert.notEqual(queryWorkspaceId, identity.userId);
});
