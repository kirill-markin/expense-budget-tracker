import assert from "node:assert/strict";
import test from "node:test";

import type { SupportedLocale } from "@/lib/locale";
import type { UserIdentity } from "@/server/users";

type ResolveWorkspaceCall = Readonly<{
  identity: UserIdentity;
  requestedWorkspaceId: string;
  initialLocale: SupportedLocale;
  initialTimezone: string | null;
}>;

type TrustedQueryCall = Readonly<{
  identity: UserIdentity;
  workspaceId: string;
  sql: string;
  params: ReadonlyArray<unknown>;
}>;

const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

test("trusted agent helpers query with a resolved accessible workspace context", async (t): Promise<void> => {
  const resolveWorkspaceCalls: Array<ResolveWorkspaceCall> = [];
  const trustedQueryCalls: Array<TrustedQueryCall> = [];

  t.mock.module("@/server/workspaceBootstrap", {
    namedExports: {
      resolveWorkspaceForIdentity: async (
        identity: UserIdentity,
        requestedWorkspaceId: string,
        initialLocale: SupportedLocale,
        initialTimezone: string | null,
      ) => {
        resolveWorkspaceCalls.push({
          identity,
          requestedWorkspaceId,
          initialLocale,
          initialTimezone,
        });

        return {
          workspaceId: "workspace-uuid-1",
          name: "Main",
          created: false,
          requestedWorkspaceAccessible: false,
        };
      },
    },
  });

  t.mock.module("@/server/db", {
    namedExports: {
      queryAsTrustedIdentity: async (
        identity: UserIdentity,
        workspaceId: string,
        sql: string,
        params: ReadonlyArray<unknown>,
      ): Promise<Readonly<{ rows: ReadonlyArray<unknown> }>> => {
        trustedQueryCalls.push({ identity, workspaceId, sql, params });

        if (sql.includes("information_schema.columns")) {
          return {
            rows: [
              {
                table_name: "accounts",
                column_name: "account_id",
                data_type: "uuid",
                udt_name: "uuid",
                is_nullable: "NO",
                column_default: null,
              },
            ],
          };
        }

        if (sql.includes("delete_workspace_for_current_user")) {
          return {
            rows: [
              {
                workspace_id: "workspace-target-1",
                name: "Project Alpha",
              },
            ],
          };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    },
  });

  const [{ getAllowedSchemaRelations }, { deleteWorkspaceForTrustedIdentity }] = await Promise.all([
    import("./agent/schema"),
    import("./workspaces"),
  ]);

  const relations = await getAllowedSchemaRelations(IDENTITY);
  const deletedWorkspace = await deleteWorkspaceForTrustedIdentity(IDENTITY, "workspace-target-1");

  assert.equal(resolveWorkspaceCalls.length, 2);
  assert.deepEqual(resolveWorkspaceCalls, [
    {
      identity: IDENTITY,
      requestedWorkspaceId: "",
      initialLocale: "en",
      initialTimezone: null,
    },
    {
      identity: IDENTITY,
      requestedWorkspaceId: "",
      initialLocale: "en",
      initialTimezone: null,
    },
  ]);

  assert.equal(trustedQueryCalls.length, 2);
  assert.equal(trustedQueryCalls[0]?.workspaceId, "workspace-uuid-1");
  assert.match(trustedQueryCalls[0]?.sql ?? "", /information_schema\.columns/);
  assert.equal(trustedQueryCalls[1]?.workspaceId, "workspace-uuid-1");
  assert.match(trustedQueryCalls[1]?.sql ?? "", /delete_workspace_for_current_user/);
  assert.deepEqual(trustedQueryCalls[1]?.params, ["workspace-target-1"]);

  const accountsRelation = relations.find((relation) => relation.name === "accounts");
  assert.ok(accountsRelation);
  assert.deepEqual(accountsRelation.columns, [
    {
      name: "account_id",
      type: "uuid",
      nullable: false,
      defaultValue: null,
    },
  ]);

  assert.deepEqual(deletedWorkspace, {
    workspaceId: "workspace-target-1",
    name: "Project Alpha",
  });
});
