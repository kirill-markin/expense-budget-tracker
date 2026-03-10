import { query, withTransaction } from "./db.js";
import { createCrockfordToken, hashOpaqueToken, normalizeCrockfordToken } from "./crockford.js";

const AGENT_OTP_HANDLE_LENGTH = 20;
const AGENT_OTP_TTL_MS = 180_000;

type AgentOtpChallengeRow = Readonly<{
  challenge_id_hash: string;
  normalized_email: string;
  cognito_session: string;
  created_at: Date | string;
  expires_at: Date | string;
  used_at: Date | string | null;
}>;

export type AgentOtpChallengeLookup =
  | Readonly<{ status: "active"; email: string; cognitoSession: string }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "expired"; email: string }>
  | Readonly<{ status: "used"; email: string }>;

const asIsoDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

/**
 * Stores a short-lived opaque handle for a Cognito OTP session. The handle is
 * shown to the client once; only its hash is persisted.
 */
export const createAgentOtpChallenge = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<string> => {
  const handle = createCrockfordToken(AGENT_OTP_HANDLE_LENGTH);
  const handleHash = hashOpaqueToken(handle);
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + AGENT_OTP_TTL_MS);

  await query(
    [
      "INSERT INTO auth.agent_otp_challenges",
      "(challenge_id_hash, normalized_email, cognito_session, created_at, expires_at)",
      "VALUES ($1, $2, $3, $4, $5)",
    ].join(" "),
    [handleHash, normalizedEmail, cognitoSession, createdAt, expiresAt],
  );

  return handle;
};

/**
 * Reissues a fresh opaque handle for the newest still-valid Cognito OTP
 * challenge. This keeps email throttling stateless without storing plaintext
 * handles after they have been returned once.
 */
export const reissueLatestAgentOtpChallenge = async (
  normalizedEmail: string,
  nowMs: number,
): Promise<string | null> => withTransaction(async (queryFn) => {
  const now = new Date(nowMs);
  const result = await queryFn(
    [
      "SELECT challenge_id_hash, normalized_email, cognito_session, created_at, expires_at, used_at",
      "FROM auth.agent_otp_challenges",
      "WHERE normalized_email = $1",
      "AND used_at IS NULL",
      "AND expires_at > $2",
      "ORDER BY created_at DESC, challenge_id_hash DESC",
      "LIMIT 1",
    ].join(" "),
    [normalizedEmail, now],
  );

  const row = result.rows[0] as AgentOtpChallengeRow | undefined;
  if (row === undefined) {
    return null;
  }

  const handle = createCrockfordToken(AGENT_OTP_HANDLE_LENGTH);
  const handleHash = hashOpaqueToken(handle);
  await queryFn(
    [
      "INSERT INTO auth.agent_otp_challenges",
      "(challenge_id_hash, normalized_email, cognito_session, created_at, expires_at)",
      "VALUES ($1, $2, $3, $4, $5)",
    ].join(" "),
    [handleHash, normalizedEmail, row.cognito_session, now, row.expires_at],
  );

  return handle;
});

/**
 * Resolves a short opaque OTP handle to its live Cognito session state.
 * Expired and already-used handles are distinguished so routes can return a
 * precise restart message.
 */
export const lookupAgentOtpChallenge = async (
  otpSessionToken: string,
  nowMs: number,
): Promise<AgentOtpChallengeLookup> => {
  let normalized: string;
  try {
    normalized = normalizeCrockfordToken(otpSessionToken, "otpSessionToken");
  } catch {
    return { status: "invalid" };
  }

  const result = await query(
    [
      "SELECT challenge_id_hash, normalized_email, cognito_session, created_at, expires_at, used_at",
      "FROM auth.agent_otp_challenges",
      "WHERE challenge_id_hash = $1",
      "LIMIT 1",
    ].join(" "),
    [hashOpaqueToken(normalized)],
  );

  const row = result.rows[0] as AgentOtpChallengeRow | undefined;
  if (row === undefined) {
    return { status: "invalid" };
  }

  const expiresAtMs = asIsoDate(row.expires_at).getTime();
  if (row.used_at !== null) {
    return { status: "used", email: row.normalized_email };
  }

  if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
    return { status: "expired", email: row.normalized_email };
  }

  return {
    status: "active",
    email: row.normalized_email,
    cognitoSession: row.cognito_session,
  };
};

/**
 * Marks every active alias for the same Cognito challenge as used once the OTP
 * verification succeeds. This prevents later aliases from appearing reusable.
 */
export const markAgentOtpChallengeUsed = async (
  normalizedEmail: string,
  cognitoSession: string,
  nowMs: number,
): Promise<void> => {
  await query(
    [
      "UPDATE auth.agent_otp_challenges",
      "SET used_at = $3",
      "WHERE normalized_email = $1",
      "AND cognito_session = $2",
      "AND used_at IS NULL",
    ].join(" "),
    [normalizedEmail, cognitoSession, new Date(nowMs)],
  );
};

export const AGENT_OTP_HANDLE_TTL_MS = AGENT_OTP_TTL_MS;
