/**
 * DB-backed anti-abuse policy for OTP sends.
 *
 * Email-level limits and IP-level limits share the same counters across all
 * OTP send entry points so callers cannot bypass quotas by switching paths.
 */
import { withTransaction } from "./db.js";

export type OtpSendDecision = "allowed" | "blocked_email_limit" | "blocked_ip_limit";

type CountRow = Readonly<{ count: string }>;

type OtpSendCounters = Readonly<{
  emailPerMinute: number;
  emailPerQuarterHour: number;
  emailPerDay: number;
  ipPerQuarterHour: number;
  ipPerHour: number;
  ipPerDay: number;
  distinctEmailsPerHour: number;
  distinctEmailsPerDay: number;
}>;

const readCount = async (
  queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<{ rows: Array<CountRow> }>,
  sql: string,
  params: ReadonlyArray<unknown>,
): Promise<number> => {
  const result = await queryFn(sql, params);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("readCount: expected a count row");
  }
  return Number.parseInt(row.count, 10);
};

export const evaluateOtpSendDecision = (counters: OtpSendCounters): OtpSendDecision => {
  if (
    counters.ipPerQuarterHour >= 10
    || counters.ipPerHour >= 30
    || counters.ipPerDay >= 100
    || counters.distinctEmailsPerHour >= 5
    || counters.distinctEmailsPerDay >= 20
  ) {
    return "blocked_ip_limit";
  }

  if (
    counters.emailPerMinute >= 1
    || counters.emailPerQuarterHour >= 3
    || counters.emailPerDay >= 10
  ) {
    return "blocked_email_limit";
  }

  return "allowed";
};

export const checkAndRecordOtpSendDecision = async (
  normalizedEmail: string,
  requestIp: string,
): Promise<OtpSendDecision> => {
  return withTransaction(async (queryFn) => {
    const [
      emailPerMinute,
      emailPerQuarterHour,
      emailPerDay,
      ipPerQuarterHour,
      ipPerHour,
      ipPerDay,
      distinctEmailsPerHour,
      distinctEmailsPerDay,
    ] = await Promise.all([
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '1 minute'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '15 minutes'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '15 minutes'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 hour'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(DISTINCT normalized_email)::text AS count
         FROM auth.otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 hour'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(DISTINCT normalized_email)::text AS count
         FROM auth.otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [requestIp],
      ),
    ]);

    const decision = evaluateOtpSendDecision({
      emailPerMinute,
      emailPerQuarterHour,
      emailPerDay,
      ipPerQuarterHour,
      ipPerHour,
      ipPerDay,
      distinctEmailsPerHour,
      distinctEmailsPerDay,
    });

    await queryFn(
      `INSERT INTO auth.otp_send_events (normalized_email, request_ip, decision)
       VALUES ($1, $2, $3)`,
      [normalizedEmail, requestIp, decision],
    );

    return decision;
  });
};
