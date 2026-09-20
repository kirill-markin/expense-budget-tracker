import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient, QueryResult } from "pg";

import { upsertUserIdentity, type UserIdentity } from "@/server/users";

const IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "person@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: true,
};

const emptyResult = (): QueryResult => ({
  command: "SELECT",
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
});

/** Fails the identity insert with the PostgreSQL error pg would raise. */
const createClientRejectingWith = (error: unknown): PoolClient => ({
  query: async (text: string): Promise<QueryResult> => {
    if (text.startsWith("INSERT INTO users")) {
      throw error;
    }
    return emptyResult();
  },
} as unknown as PoolClient);

/** Records every statement the upsert issues. */
const createRecordingClient = (statements: Array<string>): PoolClient => ({
  query: async (text: string): Promise<QueryResult> => {
    statements.push(text);
    return emptyResult();
  },
} as unknown as PoolClient);

const emailUniqueViolation = (): Error =>
  Object.assign(
    new Error('duplicate key value violates unique constraint "idx_users_email"'),
    { code: "23505", constraint: "idx_users_email" },
  );

test("an email collision keeps the PostgreSQL discriminators on the clearer error", async (): Promise<void> => {
  const cause = emailUniqueViolation();
  const client = createClientRejectingWith(cause);

  await assert.rejects(
    () => upsertUserIdentity(client, IDENTITY),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /already registered to a different user than subject user-1/u);
      // Provisioning race recovery matches on these two properties, so they must
      // survive the rewrite of the message.
      assert.equal((error as { code?: unknown }).code, "23505");
      assert.equal((error as { constraint?: unknown }).constraint, "idx_users_email");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("any other database error is rethrown untouched", async (): Promise<void> => {
  const cause = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  const client = createClientRejectingWith(cause);

  await assert.rejects(() => upsertUserIdentity(client, IDENTITY), (error: unknown): boolean => error === cause);
});

test("a browser page load provisions a first-seen user but never updates stored account state", async (): Promise<void> => {
  const statements: Array<string> = [];

  await upsertUserIdentity(createRecordingClient(statements), IDENTITY);

  const insert = statements.find((text) => text.startsWith("INSERT INTO users")) ?? "";
  // A first sighting still gets its account state.
  assert.match(insert, /INSERT INTO users \(\s+user_id,\s+email,\s+email_verified,\s+cognito_status,\s+cognito_enabled\s+\)/u);
  // An existing row keeps its account state, so a session request cannot
  // re-enable a disabled account, while email_verified keeps following the
  // verified identity token in both directions.
  const conflictUpdate = insert.slice(insert.indexOf("ON CONFLICT"));
  assert.match(
    conflictUpdate,
    /SET email = EXCLUDED\.email,\s+email_verified = EXCLUDED\.email_verified,\s+last_seen_at = now\(\),\s+updated_at = now\(\)/u,
  );
  assert.doesNotMatch(conflictUpdate, /cognito_status|cognito_enabled/u);
});
