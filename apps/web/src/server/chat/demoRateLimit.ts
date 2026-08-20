/**
 * Chat turn rate limit for demo/review accounts.
 *
 * The demo sign-in mints a session for anyone who knows the allowlisted
 * @example.com address, and that address is public, so the account is
 * effectively open. Capping its chat turns bounds the model spend a burst of
 * automated sign-ins can produce. Real accounts are never counted and never
 * refused, so the counter table only ever holds demo rows.
 *
 * The window is counted per user and deliberately not per workspace: the
 * observed abusing client creates a fresh workspace on every run, so any
 * workspace-scoped counter would reset with it.
 */
import {
  countUserChatTurnsSinceWithQuery,
  deleteUserChatTurnsBeforeWithQuery,
  lockUserChatTurnRateWithQuery,
  recordUserChatTurnWithQuery,
} from "@/server/chat/store";
import type { QueryFn } from "@/server/db/contextRunner";
import { withUserOnlyContext } from "@/server/db";
import { isDemoAccountEmail } from "@/server/demoAccounts";

/**
 * Peak legitimate demo load is 8 turns per hour (four deploys in one hour, two
 * AI-chat turns each in the live smoke test), so this leaves 2.5x headroom.
 */
export const DEMO_CHAT_TURN_LIMIT_PER_HOUR = 20;

const DEMO_CHAT_TURN_WINDOW_MS = 60 * 60 * 1000;

export type DemoChatTurnDecision =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "refused"; recentTurnCount: number; limit: number }>;

/**
 * Decide and record one turn against this user's window.
 *
 * `queryFn` must be bound to a single transaction: the advisory lock taken
 * first is transaction-scoped, and it is what makes prune, count and insert
 * atomic per user. Without it a burst of concurrent turns would all count
 * before any of them inserted, and the cap would overshoot by the caller's
 * concurrency rather than hold.
 */
export const admitDemoChatTurnWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  now: Date,
): Promise<DemoChatTurnDecision> => {
  await lockUserChatTurnRateWithQuery(queryFn, userId);
  const windowStart = new Date(now.getTime() - DEMO_CHAT_TURN_WINDOW_MS);
  await deleteUserChatTurnsBeforeWithQuery(queryFn, userId, windowStart);
  const recentTurnCount = await countUserChatTurnsSinceWithQuery(queryFn, userId, windowStart);
  if (recentTurnCount >= DEMO_CHAT_TURN_LIMIT_PER_HOUR) {
    return {
      kind: "refused",
      recentTurnCount,
      limit: DEMO_CHAT_TURN_LIMIT_PER_HOUR,
    };
  }

  await recordUserChatTurnWithQuery(queryFn, userId);
  return { kind: "allowed" };
};

/**
 * Decide whether one more chat turn may start, and record it when it may.
 *
 * Must be called before the run starts and before any model call, because an
 * allowed decision consumes one turn of the window.
 *
 * `withUserOnlyContext` runs the whole decision in one transaction on one
 * connection, which is what keeps the advisory lock covering the count and the
 * insert. The lock must never be taken on a second connection or outside this
 * transaction.
 */
export const admitDemoChatTurn = async (
  userId: string,
  email: string,
): Promise<DemoChatTurnDecision> => {
  if (!isDemoAccountEmail(email)) {
    return { kind: "allowed" };
  }

  return withUserOnlyContext(userId, async (queryFn) =>
    admitDemoChatTurnWithQuery(queryFn, userId, new Date()));
};
