import assert from "node:assert/strict";
import test from "node:test";

import type { SupportedLocale } from "@/lib/locale";
import type { UserIdentity } from "@/server/users";

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type QueryResultShape = Readonly<{
  rows: ReadonlyArray<unknown>;
}>;

type FakeClient = Readonly<{
  query: (text: string, params?: Array<unknown>) => Promise<QueryResultShape>;
  release: () => void;
}>;

const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

test("resolveWorkspaceForIdentity sets workspace RLS context before ensuring requested workspace settings", async (t): Promise<void> => {
  const queryCalls: Array<QueryCall> = [];
  let selectedWorkspaceId = "";
  let released = false;

  const client: FakeClient = {
    query: async (text: string, params?: Array<unknown>): Promise<QueryResultShape> => {
      const queryParams = params ?? [];
      queryCalls.push({ text, params: queryParams });

      if (text === "BEGIN" || text === "COMMIT") {
        return { rows: [] };
      }

      if (text === "SELECT set_config('app.user_id', $1, true)") {
        return { rows: [] };
      }

      if (text === "SELECT set_config('app.workspace_id', $1, true)") {
        selectedWorkspaceId = String(queryParams[0]);
        return { rows: [] };
      }

      if (text.includes("FROM workspaces w") && text.includes("JOIN workspace_members wm")) {
        return {
          rows: [
            {
              workspace_id: "workspace-1",
              name: "Main",
            },
          ],
        };
      }

      if (text.includes("INSERT INTO workspace_settings")) {
        assert.equal(selectedWorkspaceId, "workspace-1");
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release: (): void => {
      released = true;
    },
  };

  t.mock.module("@/server/db/pool", {
    namedExports: {
      getPool: () => ({
        connect: async (): Promise<FakeClient> => client,
      }),
    },
  });

  t.mock.module("@/server/users", {
    namedExports: {
      upsertUserIdentity: async (): Promise<void> => undefined,
      ensureUserSettingsRow: async (): Promise<void> => undefined,
    },
  });

  const { resolveWorkspaceForIdentity } = await import("./workspaceBootstrap");
  const workspace = await resolveWorkspaceForIdentity(
    IDENTITY,
    "workspace-1",
    "en" satisfies SupportedLocale,
    "Europe/Madrid",
  );

  assert.equal(workspace.workspaceId, "workspace-1");
  assert.equal(workspace.requestedWorkspaceAccessible, true);
  assert.equal(released, true);

  const workspaceContextIndex = queryCalls.findIndex((call) =>
    call.text === "SELECT set_config('app.workspace_id', $1, true)"
  );
  const settingsInsertIndex = queryCalls.findIndex((call) =>
    call.text.includes("INSERT INTO workspace_settings")
  );

  assert.notEqual(workspaceContextIndex, -1);
  assert.notEqual(settingsInsertIndex, -1);
  assert.ok(workspaceContextIndex < settingsInsertIndex);
});
