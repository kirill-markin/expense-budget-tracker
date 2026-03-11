import test from "node:test";
import assert from "node:assert/strict";
import {
  createCheckAndRecordOtpSendDecision,
  evaluateOtpSendDecision,
  type OtpRateLimitQueryFn,
  type OtpRateLimitTransactionRunner,
} from "./otpRateLimit.js";

type CounterKey =
  | "emailPerMinute"
  | "emailPerQuarterHour"
  | "emailPerDay"
  | "ipPerQuarterHour"
  | "ipPerHour"
  | "ipPerDay"
  | "distinctEmailsPerHour"
  | "distinctEmailsPerDay";

type CounterMap = Readonly<Record<CounterKey, number>>;

type QueryResultRow = Readonly<{ count: string }>;
type QueryResultShape = Readonly<{ rows: Array<QueryResultRow> }>;

const createTransactionRunner = (
  queryHandler: (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResultShape>,
): OtpRateLimitTransactionRunner => {
  const runner: OtpRateLimitTransactionRunner = async <T>(
    callback: (queryFn: OtpRateLimitQueryFn) => Promise<T>,
  ): Promise<T> => {
    const queryFn: OtpRateLimitQueryFn = async (
      text: string,
      params: ReadonlyArray<unknown>,
    ) => {
      const result = await queryHandler(text, params);
      return result as Awaited<ReturnType<OtpRateLimitQueryFn>>;
    };

    return callback(queryFn);
  };

  return runner;
};

const resolveCounterKey = (sql: string): CounterKey => {
  if (sql.includes("COUNT(DISTINCT normalized_email)") && sql.includes("INTERVAL '1 hour'")) {
    return "distinctEmailsPerHour";
  }

  if (sql.includes("COUNT(DISTINCT normalized_email)") && sql.includes("INTERVAL '1 day'")) {
    return "distinctEmailsPerDay";
  }

  if (sql.includes("normalized_email = $1") && sql.includes("INTERVAL '1 minute'")) {
    return "emailPerMinute";
  }

  if (sql.includes("normalized_email = $1") && sql.includes("INTERVAL '15 minutes'")) {
    return "emailPerQuarterHour";
  }

  if (sql.includes("normalized_email = $1") && sql.includes("INTERVAL '1 day'")) {
    return "emailPerDay";
  }

  if (sql.includes("request_ip = $1") && sql.includes("INTERVAL '15 minutes'")) {
    return "ipPerQuarterHour";
  }

  if (sql.includes("request_ip = $1") && sql.includes("INTERVAL '1 hour'")) {
    return "ipPerHour";
  }

  if (sql.includes("request_ip = $1") && sql.includes("INTERVAL '1 day'")) {
    return "ipPerDay";
  }

  throw new Error(`resolveCounterKey: unsupported SQL query: ${sql}`);
};

test("evaluateOtpSendDecision returns allowed below all thresholds", () => {
  const decision = evaluateOtpSendDecision({
    emailPerMinute: 2,
    emailPerQuarterHour: 4,
    emailPerDay: 9,
    ipPerQuarterHour: 9,
    ipPerHour: 29,
    ipPerDay: 99,
    distinctEmailsPerHour: 4,
    distinctEmailsPerDay: 19,
  });

  assert.equal(decision, "allowed");
});

test("evaluateOtpSendDecision blocks at email thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 3,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 5,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 10,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_email_limit",
  );
});

test("evaluateOtpSendDecision blocks at IP thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 10,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 30,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 100,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );
});

test("evaluateOtpSendDecision blocks at distinct-email-per-IP thresholds", () => {
  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 5,
      distinctEmailsPerDay: 0,
    }),
    "blocked_ip_limit",
  );

  assert.equal(
    evaluateOtpSendDecision({
      emailPerMinute: 0,
      emailPerQuarterHour: 0,
      emailPerDay: 0,
      ipPerQuarterHour: 0,
      ipPerHour: 0,
      ipPerDay: 0,
      distinctEmailsPerHour: 0,
      distinctEmailsPerDay: 20,
    }),
    "blocked_ip_limit",
  );
});

test("checkAndRecordOtpSendDecision applies allowed-only filter in all counter queries", async () => {
  const selectQueries: Array<string> = [];
  const checkAndRecordOtpSendDecision = createCheckAndRecordOtpSendDecision(
    createTransactionRunner(async (text) => {
      if (text.includes("INSERT INTO auth.otp_send_events")) {
        return { rows: [] };
      }

      selectQueries.push(text);
      assert.match(text, /decision = 'allowed'/);
      return { rows: [{ count: "0" }] };
    }),
  );

  await checkAndRecordOtpSendDecision("user@example.com", "203.0.113.10");
  assert.equal(selectQueries.length, 8);
});

test("checkAndRecordOtpSendDecision still inserts blocked_email_limit decisions", async () => {
  const insertedStatements: Array<ReadonlyArray<unknown>> = [];
  const thresholdCounters: CounterMap = {
    emailPerMinute: 0,
    emailPerQuarterHour: 0,
    emailPerDay: 10,
    ipPerQuarterHour: 0,
    ipPerHour: 0,
    ipPerDay: 0,
    distinctEmailsPerHour: 0,
    distinctEmailsPerDay: 0,
  };

  const checkAndRecordOtpSendDecision = createCheckAndRecordOtpSendDecision(
    createTransactionRunner(async (text, params) => {
      if (text.includes("INSERT INTO auth.otp_send_events")) {
        insertedStatements.push(params);
        return { rows: [] };
      }

      const key = resolveCounterKey(text);
      return { rows: [{ count: String(thresholdCounters[key]) }] };
    }),
  );

  const decision = await checkAndRecordOtpSendDecision("user@example.com", "203.0.113.10");
  assert.equal(decision, "blocked_email_limit");
  assert.equal(insertedStatements.length, 1);
  assert.deepEqual(insertedStatements[0], ["user@example.com", "203.0.113.10", "blocked_email_limit"]);
});

test("checkAndRecordOtpSendDecision ignores blocked events in counters", async () => {
  const allowedCounters: CounterMap = {
    emailPerMinute: 2,
    emailPerQuarterHour: 4,
    emailPerDay: 9,
    ipPerQuarterHour: 9,
    ipPerHour: 29,
    ipPerDay: 99,
    distinctEmailsPerHour: 4,
    distinctEmailsPerDay: 19,
  };
  const combinedCounters: CounterMap = {
    emailPerMinute: 9,
    emailPerQuarterHour: 9,
    emailPerDay: 99,
    ipPerQuarterHour: 99,
    ipPerHour: 99,
    ipPerDay: 999,
    distinctEmailsPerHour: 9,
    distinctEmailsPerDay: 99,
  };

  const checkAndRecordOtpSendDecision = createCheckAndRecordOtpSendDecision(
    createTransactionRunner(async (text) => {
      if (text.includes("INSERT INTO auth.otp_send_events")) {
        return { rows: [] };
      }

      const key = resolveCounterKey(text);
      const counters = text.includes("decision = 'allowed'") ? allowedCounters : combinedCounters;
      return { rows: [{ count: String(counters[key]) }] };
    }),
  );

  const decision = await checkAndRecordOtpSendDecision("user@example.com", "203.0.113.10");
  assert.equal(decision, "allowed");
});
