export const OTP_CHALLENGE_TTL_MS = 180_000;
export const OTP_VERIFY_MAX_ATTEMPTS = 5;

type ChallengeTiming = Readonly<{
  expiresAt: Date | string;
  usedAt: Date | string | null;
  failedAttempts: number;
}>;

const asDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

export const isChallengeExpired = (
  challenge: ChallengeTiming,
  nowMs: number,
): boolean => {
  if (challenge.usedAt !== null) {
    return true;
  }

  if (challenge.failedAttempts >= OTP_VERIFY_MAX_ATTEMPTS) {
    return true;
  }

  return asDate(challenge.expiresAt).getTime() <= nowMs;
};

export const getNextFailedAttemptState = (failedAttempts: number): Readonly<{
  failedAttempts: number;
  exhausted: boolean;
}> => {
  const nextFailedAttempts = failedAttempts + 1;
  return {
    failedAttempts: nextFailedAttempts,
    exhausted: nextFailedAttempts >= OTP_VERIFY_MAX_ATTEMPTS,
  };
};
