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

test("the provisioning upsert writes both account-state columns from the incoming row only", async (): Promise<void> => {
  const statements: Array<RecordedStatement> = [];

  await upsertUserIdentity(recordingQueryFn(statements), DISABLED_IDENTITY);

  const insert = statements.find((statement) => statement.text.includes("INSERT INTO users"));
  const text = insert?.text ?? "";
  assert.match(text, /cognito_status = EXCLUDED\.cognito_status/u);
  assert.match(text, /cognito_enabled = EXCLUDED\.cognito_enabled/u);
  assert.equal(/cognito_enabled\s*=\s*true/iu.test(text), false);
});
