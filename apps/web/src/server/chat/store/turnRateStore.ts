/**
 * Access to public.chat_turn_rate_events, the per-user chat turn counter that
 * backs the demo account chat rate limit.
 *
 * The table has no workspace_id and its RLS policy keys on app.user_id only, on
 * purpose: a client that creates a fresh workspace per run must still see its
 * own earlier turns. Every statement here is keyed on user_id alone and must be
 * run through a user-scoped context that does not provision a workspace.
 *
 * The read-then-write sequence is not atomic under READ COMMITTED, so callers
 * must take the per-user advisory lock below before counting.
 */
import type { QueryFn } from "@/server/db/contextRunner";

type ChatTurnCountRow = Readonly<{
  chat_turn_count: string;
}>;

/**
 * Same key derivation as the other per-user serialization points
 * (`upsertUserIdentity` in @/server/users, the workspace bootstrap helpers in
 * db/migrations/0039_workspace_bootstrap_helpers.sql), so one user's writes
 * queue behind each other instead of racing.
 */
const LOCK_USER_CHAT_TURN_RATE_SQL = `
  SELECT pg_advisory_xact_lock((('x' || substr(md5($1), 1, 16))::bit(64))::bigint)
`;

const COUNT_USER_CHAT_TURNS_SINCE_SQL = `
  SELECT COUNT(*)::text AS chat_turn_count
  FROM public.chat_turn_rate_events
  WHERE user_id = $1
    AND created_at >= $2::timestamptz
`;

const DELETE_USER_CHAT_TURNS_BEFORE_SQL = `
  DELETE FROM public.chat_turn_rate_events
  WHERE user_id = $1
    AND created_at < $2::timestamptz
`;

const INSERT_USER_CHAT_TURN_SQL = `
  INSERT INTO public.chat_turn_rate_events (user_id)
  VALUES ($1)
`;

/**
 * Serialize this user's whole rate-limit window for the rest of the transaction.
 *
 * Without it, concurrent turns of the same user all run their COUNT before any
 * of them commits its INSERT, so every one of them reads a sub-limit count and
 * proceeds: the overshoot scales with the caller's concurrency instead of being
 * bounded by the limit. The demo credentials are public and nothing else in the
 * chat path serializes a single user, so this lock is what makes the cap hold
 * against a burst.
 *
 * The lock is transaction-scoped, so it always releases on COMMIT or ROLLBACK,
 * and it is keyed on user_id alone: keying it on anything workspace-related
 * would reintroduce the workspace-churn bypass this table exists to close.
 * Callers must issue it inside the same transaction as the count and the
 * insert, before the count.
 */
export const lockUserChatTurnRateWithQuery = async (
  queryFn: QueryFn,
  userId: string,
): Promise<void> => {
  await queryFn(LOCK_USER_CHAT_TURN_RATE_SQL, [userId]);
};

export const countUserChatTurnsSinceWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  since: Date,
): Promise<number> => {
  const result = await queryFn(COUNT_USER_CHAT_TURNS_SINCE_SQL, [userId, since]);
  const rawCount = (result.rows[0] as ChatTurnCountRow | undefined)?.chat_turn_count;
  const count = typeof rawCount === "string" && /^(?:0|[1-9]\d*)$/u.test(rawCount)
    ? Number(rawCount)
    : Number.NaN;
  if (!Number.isSafeInteger(count)) {
    throw new Error(
      `Count user chat turn rate events failed: invalid chat_turn_count=${String(rawCount)}, userId=${userId}, since=${since.toISOString()}`,
    );
  }

  return count;
};

/** Opportunistic cleanup so the counter table stays bounded per user. */
export const deleteUserChatTurnsBeforeWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  before: Date,
): Promise<void> => {
  await queryFn(DELETE_USER_CHAT_TURNS_BEFORE_SQL, [userId, before]);
};

export const recordUserChatTurnWithQuery = async (
  queryFn: QueryFn,
  userId: string,
): Promise<void> => {
  await queryFn(INSERT_USER_CHAT_TURN_SQL, [userId]);
};
