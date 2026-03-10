/**
 * DB-backed anti-abuse policy for agent OTP sends.
 *
 * Email-level limits suppress the actual send but still return a normal
 * success envelope so the route does not become an oracle. IP-level abuse is
 * blocked with an explicit 429 response.
 */
import { withTransaction } from "./db.js";

export type AgentOtpDecision = "allowed" | "suppressed_email_limit" | "blocked_ip_limit";

type CountRow = Readonly<{ count: string }>;

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

export const checkAndRecordAgentOtpDecision = async (
  normalizedEmail: string,
  requestIp: string,
): Promise<AgentOtpDecision> => {
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
         FROM auth.agent_otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '1 minute'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.agent_otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '15 minutes'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.agent_otp_send_events
         WHERE normalized_email = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [normalizedEmail],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.agent_otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '15 minutes'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.agent_otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 hour'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(*)::text AS count
         FROM auth.agent_otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(DISTINCT normalized_email)::text AS count
         FROM auth.agent_otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 hour'`,
        [requestIp],
      ),
      readCount(
        queryFn,
        `SELECT COUNT(DISTINCT normalized_email)::text AS count
         FROM auth.agent_otp_send_events
         WHERE request_ip = $1
           AND created_at >= now() - INTERVAL '1 day'`,
        [requestIp],
      ),
    ]);

    let decision: AgentOtpDecision = "allowed";

    if (
      ipPerQuarterHour >= 10
      || ipPerHour >= 30
      || ipPerDay >= 100
      || distinctEmailsPerHour >= 5
      || distinctEmailsPerDay >= 20
    ) {
      decision = "blocked_ip_limit";
    } else if (
      emailPerMinute >= 1
      || emailPerQuarterHour >= 3
      || emailPerDay >= 10
    ) {
      // The email-level branch intentionally records the suppressed event and
      // returns a normal success envelope to avoid exposing a send oracle.
      decision = "suppressed_email_limit";
    }

    await queryFn(
      `INSERT INTO auth.agent_otp_send_events (normalized_email, request_ip, decision)
       VALUES ($1, $2, $3)`,
      [normalizedEmail, requestIp, decision],
    );

    return decision;
  });
};
