import { query, withTransaction } from "../db.js";
import { createCrockfordToken, hashOpaqueToken, normalizeCrockfordToken } from "../crockford.js";
import { isChallengeExpired, OTP_CHALLENGE_TTL_MS, OTP_VERIFY_MAX_ATTEMPTS } from "./otpChallenges.js";

const OTP_HANDLE_LENGTH = 20;

type OtpTransport = "browser" | "agent";

type OtpChallengeRow = Readonly<{
  challenge_id_hash: string;
  transport: OtpTransport;
  normalized_email: string;
  cognito_session: string;
  csrf_token: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
  failed_attempts: number;
}>;

type ChallengeLookup =
  | Readonly<{ status: "active"; email: string; cognitoSession: string; csrfToken: string | null }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "expired"; email: string }>
  | Readonly<{ status: "used"; email: string }>;

export type BrowserOtpChallengeLookup =
  | Readonly<{ status: "active"; email: string; cognitoSession: string; csrfToken: string }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "expired"; email: string }>
  | Readonly<{ status: "used"; email: string }>;

export type AgentOtpChallengeLookup =
  | Readonly<{ status: "active"; email: string; cognitoSession: string }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "expired"; email: string }>
  | Readonly<{ status: "used"; email: string }>;

const createOtpChallenge = async (
  transport: OtpTransport,
  normalizedEmail: string,
  cognitoSession: string,
  csrfToken: string | null,
  nowMs: number,
): Promise<string> => {
  const handle = createCrockfordToken(OTP_HANDLE_LENGTH);
  const handleHash = hashOpaqueToken(handle);
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + OTP_CHALLENGE_TTL_MS);

  await query(
    [
      "INSERT INTO auth.otp_challenges",
      "(challenge_id_hash, transport, normalized_email, cognito_session, csrf_token, created_at, expires_at, failed_attempts)",
      "VALUES ($1, $2, $3, $4, $5, $6, $7, 0)",
    ].join(" "),
    [handleHash, transport, normalizedEmail, cognitoSession, csrfToken, createdAt, expiresAt],
  );

  return handle;
};

const lookupOtpChallenge = async (
  transport: OtpTransport,
  otpSessionToken: string,
  nowMs: number,
): Promise<ChallengeLookup> => {
  let normalized: string;
  try {
    normalized = normalizeCrockfordToken(otpSessionToken, "otpSessionToken");
  } catch {
    return { status: "invalid" };
  }

  const result = await query(
    [
      "SELECT challenge_id_hash, transport, normalized_email, cognito_session, csrf_token, created_at, expires_at, used_at, failed_attempts",
      "FROM auth.otp_challenges",
      "WHERE challenge_id_hash = $1",
      "AND transport = $2",
      "LIMIT 1",
    ].join(" "),
    [hashOpaqueToken(normalized), transport],
  );

  const row = result.rows[0] as OtpChallengeRow | undefined;
  if (row === undefined) {
    return { status: "invalid" };
  }

  if (row.used_at !== null) {
    return { status: "used", email: row.normalized_email };
  }

  if (isChallengeExpired({
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    failedAttempts: row.failed_attempts,
  }, nowMs)) {
    return { status: "expired", email: row.normalized_email };
  }

  return {
    status: "active",
    email: row.normalized_email,
    cognitoSession: row.cognito_session,
    csrfToken: row.csrf_token,
  };
};

const recordOtpChallengeFailure = async (
  transport: OtpTransport,
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<Readonly<{ expired: boolean }>> => {
  const result = await query(
    [
      "UPDATE auth.otp_challenges",
      "SET failed_attempts = failed_attempts + 1,",
      "    expires_at = CASE",
      `      WHEN failed_attempts + 1 >= ${OTP_VERIFY_MAX_ATTEMPTS} THEN $4`,
      "      ELSE expires_at",
      "    END",
      "WHERE transport = $1",
      "AND normalized_email = $2",
      "AND cognito_session = $3",
      "AND used_at IS NULL",
      "AND expires_at > $4",
      "RETURNING failed_attempts, expires_at",
    ].join(" "),
    [transport, normalizedEmail, cognitoSession, new Date(nowMs)],
  );

  if (result.rows.length === 0) {
    return { expired: true };
  }

  const row = result.rows[0] as Readonly<{
    failed_attempts: number;
    expires_at: Date | string;
  }>;

  return {
    expired: isChallengeExpired({
      expiresAt: row.expires_at,
      usedAt: null,
      failedAttempts: row.failed_attempts,
    }, nowMs),
  };
};

const markOtpChallengeUsed = async (
  transport: OtpTransport,
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<void> => {
  await query(
    [
      "UPDATE auth.otp_challenges",
      "SET used_at = $4",
      "WHERE transport = $1",
      "AND normalized_email = $2",
      "AND cognito_session = $3",
      "AND used_at IS NULL",
    ].join(" "),
    [transport, normalizedEmail, cognitoSession, new Date(nowMs)],
  );
};

export const createBrowserOtpChallenge = async (
  normalizedEmail: string,
  cognitoSession: string,
  csrfToken: string,
  nowMs: number,
): Promise<string> =>
  createOtpChallenge("browser", normalizedEmail, cognitoSession, csrfToken, nowMs);

export const lookupBrowserOtpChallenge = async (
  otpSessionToken: string,
  nowMs: number,
): Promise<BrowserOtpChallengeLookup> => {
  const challenge = await lookupOtpChallenge("browser", otpSessionToken, nowMs);
  if (challenge.status !== "active") {
    return challenge;
  }

  if (challenge.csrfToken === null || challenge.csrfToken === "") {
    return { status: "invalid" };
  }

  return {
    status: "active",
    email: challenge.email,
    cognitoSession: challenge.cognitoSession,
    csrfToken: challenge.csrfToken,
  };
};

export const recordBrowserOtpChallengeFailure = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<Readonly<{ expired: boolean }>> =>
  recordOtpChallengeFailure("browser", normalizedEmail, cognitoSession, nowMs);

export const markBrowserOtpChallengeUsed = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<void> =>
  markOtpChallengeUsed("browser", normalizedEmail, cognitoSession, nowMs);

export const createAgentOtpChallenge = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<string> =>
  createOtpChallenge("agent", normalizedEmail, cognitoSession, null, nowMs);

export const reissueLatestAgentOtpChallenge = async (
  normalizedEmail: string,
  nowMs: number,
): Promise<string | null> => withTransaction(async (queryFn) => {
  const now = new Date(nowMs);
  const result = await queryFn(
    [
      "SELECT challenge_id_hash, transport, normalized_email, cognito_session, csrf_token, created_at, expires_at, used_at, failed_attempts",
      "FROM auth.otp_challenges",
      "WHERE transport = 'agent'",
      "AND normalized_email = $1",
      "AND used_at IS NULL",
      "AND expires_at > $2",
      `AND failed_attempts < ${OTP_VERIFY_MAX_ATTEMPTS}`,
      "ORDER BY created_at DESC, challenge_id_hash DESC",
      "LIMIT 1",
    ].join(" "),
    [normalizedEmail, now],
  );

  const row = result.rows[0] as OtpChallengeRow | undefined;
  if (row === undefined) {
    return null;
  }

  const handle = createCrockfordToken(OTP_HANDLE_LENGTH);
  const handleHash = hashOpaqueToken(handle);
  await queryFn(
    [
      "INSERT INTO auth.otp_challenges",
      "(challenge_id_hash, transport, normalized_email, cognito_session, csrf_token, created_at, expires_at, failed_attempts)",
      "VALUES ($1, 'agent', $2, $3, NULL, $4, $5, 0)",
    ].join(" "),
    [handleHash, normalizedEmail, row.cognito_session, now, row.expires_at],
  );

  return handle;
});

export const lookupAgentOtpChallenge = async (
  otpSessionToken: string,
  nowMs: number,
): Promise<AgentOtpChallengeLookup> => {
  const challenge = await lookupOtpChallenge("agent", otpSessionToken, nowMs);
  if (challenge.status !== "active") {
    return challenge;
  }

  return {
    status: "active",
    email: challenge.email,
    cognitoSession: challenge.cognitoSession,
  };
};

export const recordAgentOtpChallengeFailure = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<Readonly<{ expired: boolean }>> =>
  recordOtpChallengeFailure("agent", normalizedEmail, cognitoSession, nowMs);

export const markAgentOtpChallengeUsed = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<void> =>
  markOtpChallengeUsed("agent", normalizedEmail, cognitoSession, nowMs);

export const OTP_HANDLE_TTL_MS = OTP_CHALLENGE_TTL_MS;
