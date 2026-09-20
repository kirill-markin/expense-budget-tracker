import assert from "node:assert/strict";
import test from "node:test";
import { upsertUserIdentity, type QueryFn, type UserIdentity } from "./db.js";
import { createQueryResult } from "./handlerTestUtils.js";

const DISABLED_IDENTITY: UserIdentity = {
  userId: "user-1",
  email: "user@example.com",
  emailVerified: true,
  cognitoStatus: "CONFIRMED",
  cognitoEnabled: false,
};

type RecordedStatement = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const recordingQueryFn = (statements: Array<RecordedStatement>): QueryFn => async (text, params) => {
  statements.push({ text, params });
  return createQueryResult([]);
};

test("the provisioning upsert persists the account state it is given, never a hardcoded enabled account", async (): Promise<void> => {
  const statements: Array<RecordedStatement> = [];

  await upsertUserIdentity(recordingQueryFn(statements), DISABLED_IDENTITY);

  const insert = statements.find((statement) => statement.text.includes("INSERT INTO users"));
  assert.notEqual(insert, undefined);
  assert.deepEqual(insert?.params, [
    "user-1",
    "user@example.com",
    true,
    "CONFIRMED",
    false,
  ]);
});

test("the provisioning upsert never updates the stored account state on conflict", async (): Promise<void> => {
  const statements: Array<RecordedStatement> = [];

  await upsertUserIdentity(recordingQueryFn(statements), DISABLED_IDENTITY);

  const insert = statements.find((statement) => statement.text.includes("INSERT INTO users"));
  const text = insert?.text ?? "";
  // A first-seen user is still provisioned with the account state it is given.
  assert.match(text, /INSERT INTO users \(\s+user_id,\s+email,\s+email_verified,\s+cognito_status,\s+cognito_enabled\s+\)/u);
  const conflictUpdate = text.slice(text.indexOf("ON CONFLICT"));
  assert.match(
    conflictUpdate,
    /SET email = EXCLUDED\.email,\s+email_verified = EXCLUDED\.email_verified,\s+last_seen_at = now\(\),\s+updated_at = now\(\)/u,
  );
  // email_verified is the provider's claim, not a lever, so it stays updatable.
  assert.doesNotMatch(conflictUpdate, /cognito_status|cognito_enabled/u);
});
