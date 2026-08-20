import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import {
  admitDemoChatTurn,
  admitDemoChatTurnWithQuery,
  DEMO_CHAT_TURN_LIMIT_PER_HOUR,
} from "@/server/chat/demoRateLimit";
import { runWithContext, type DbClient, type DbPool, type QueryFn } from "@/server/db/contextRunner";
import { resetDemoAccountAllowlistForTests } from "@/server/demoAccounts";

const DEMO_EMAIL_ENV = "DEMO_EMAIL_DOSTIP";
const DEMO_EMAIL = "e2e-test@example.com";
const NOW = new Date("2026-08-20T12:00:00.000Z");

type RecordedQuery = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const createCountingQueryFn = (
  recentTurnCount: number,
  recordedQueries: Array<RecordedQuery>,
): QueryFn =>
  async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    return {
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: text.includes("COUNT(*)")
        ? [{ chat_turn_count: String(recentTurnCount) }]
        : [],
    };
  };

const withDemoEmailAllowlist = async (
  value: string,
  run: () => Promise<void>,
): Promise<void> => {
  const previousValue = process.env[DEMO_EMAIL_ENV];
  process.env[DEMO_EMAIL_ENV] = value;
  resetDemoAccountAllowlistForTests();
  try {
    await run();
  } finally {
    if (previousValue === undefined) {
      delete process.env[DEMO_EMAIL_ENV];
    } else {
      process.env[DEMO_EMAIL_ENV] = previousValue;
    }
    resetDemoAccountAllowlistForTests();
  }
};

test("a demo account is refused once the rolling hour reached the limit", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const decision = await admitDemoChatTurnWithQuery(
    createCountingQueryFn(DEMO_CHAT_TURN_LIMIT_PER_HOUR, recordedQueries),
    "user-1",
    NOW,
  );

  assert.deepEqual(decision, {
    kind: "refused",
    recentTurnCount: DEMO_CHAT_TURN_LIMIT_PER_HOUR,
    limit: DEMO_CHAT_TURN_LIMIT_PER_HOUR,
  });
  assert.equal(recordedQueries.some((query) => query.text.includes("INSERT INTO")), false);
});

test("a demo account below the limit records the turn and prunes the expired window", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const decision = await admitDemoChatTurnWithQuery(
    createCountingQueryFn(DEMO_CHAT_TURN_LIMIT_PER_HOUR - 1, recordedQueries),
    "user-1",
    NOW,
  );

  assert.deepEqual(decision, { kind: "allowed" });
  const windowStart = new Date("2026-08-20T11:00:00.000Z");
  assert.match(recordedQueries[0]?.text ?? "", /pg_advisory_xact_lock/u);
  assert.deepEqual(recordedQueries[0]?.params, ["user-1"]);
  assert.match(recordedQueries[1]?.text ?? "", /DELETE FROM public\.chat_turn_rate_events/u);
  assert.deepEqual(recordedQueries[1]?.params, ["user-1", windowStart]);
  assert.match(recordedQueries[2]?.text ?? "", /COUNT\(\*\)/u);
  assert.deepEqual(recordedQueries[2]?.params, ["user-1", windowStart]);
  assert.match(recordedQueries[3]?.text ?? "", /INSERT INTO public\.chat_turn_rate_events/u);
  assert.deepEqual(recordedQueries[3]?.params, ["user-1"]);
});

test("the demo chat turn counter is keyed on the user only, never on a workspace", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  await admitDemoChatTurnWithQuery(
    createCountingQueryFn(0, recordedQueries),
    "user-1",
    NOW,
  );

  assert.equal(recordedQueries.length, 4);
  for (const query of recordedQueries) {
    assert.equal(query.text.includes("workspace"), false);
    assert.equal(query.params.includes("workspace-1"), false);
    assert.deepEqual(query.params[0], "user-1");
  }
  for (const query of recordedQueries.slice(1)) {
    assert.match(query.text, /user_id/u);
  }
});

test("the advisory lock is transaction-scoped, keyed on the user, and taken before the count", async (): Promise<void> => {
  const recordedQueries: Array<RecordedQuery> = [];
  const countingQueryFn = createCountingQueryFn(0, recordedQueries);
  const client: DbClient = {
    query: async (text, params): Promise<QueryResult> =>
      countingQueryFn(text, params ?? []),
    release: (): void => {},
  };
  const pool: DbPool = {
    connect: async (): Promise<DbClient> => client,
  };

  const decision = await runWithContext(
    pool,
    {
      userId: "user-1",
      workspaceId: "",
      statementTimeoutMs: null,
      useRestrictedRole: false,
    },
    async (queryFn) => admitDemoChatTurnWithQuery(queryFn, "user-1", NOW),
  );

  assert.deepEqual(decision, { kind: "allowed" });
  const statements = recordedQueries.map((query) => query.text);
  const indexOfMatch = (pattern: RegExp): number =>
    statements.findIndex((text) => pattern.test(text));
  const beginIndex = indexOfMatch(/^BEGIN$/u);
  const lockIndex = indexOfMatch(/pg_advisory_xact_lock/u);
  const countIndex = indexOfMatch(/COUNT\(\*\)/u);
  const insertIndex = indexOfMatch(/INSERT INTO public\.chat_turn_rate_events/u);
  const commitIndex = indexOfMatch(/^COMMIT$/u);

  // The lock lives strictly inside the transaction that also counts and inserts,
  // so the whole decision is atomic per user and the lock always releases.
  assert.equal(beginIndex, 0);
  assert.ok(beginIndex < lockIndex);
  assert.ok(lockIndex < countIndex);
  assert.ok(countIndex < insertIndex);
  assert.ok(insertIndex < commitIndex);
  assert.deepEqual(recordedQueries[lockIndex]?.params, ["user-1"]);
  // Session-scoped locks would survive the transaction and leak on an error.
  assert.equal(statements.some((text) => /pg_advisory_lock\(/u.test(text)), false);
});

test("a real account is never counted and never refused while demo emails are configured", async (): Promise<void> => {
  await withDemoEmailAllowlist(DEMO_EMAIL, async (): Promise<void> => {
    const decision = await admitDemoChatTurn("user-1", "person@real.example");
    assert.deepEqual(decision, { kind: "allowed" });
  });
});

test("an empty demo allowlist disables the cap for every account", async (): Promise<void> => {
  await withDemoEmailAllowlist("", async (): Promise<void> => {
    const decision = await admitDemoChatTurn("user-1", DEMO_EMAIL);
    assert.deepEqual(decision, { kind: "allowed" });
  });
});
