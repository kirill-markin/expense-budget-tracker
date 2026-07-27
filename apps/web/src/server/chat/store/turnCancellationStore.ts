import type { QueryFn } from "@/server/db/contextRunner";
import {
  ChatTurnCancelledError,
} from "./shared";
import {
  lockActiveChatSessionRunWithQuery,
} from "./sessionStore";

const HAS_CHAT_TURN_CANCELLATION_SQL = `
  SELECT turn_id
  FROM public.chat_turn_cancellations
  WHERE session_id = $1
    AND turn_id = $2
`;

const INSERT_CHAT_TURN_CANCELLATION_SQL = `
  INSERT INTO public.chat_turn_cancellations (
    session_id,
    turn_id
  )
  VALUES ($1, $2)
  ON CONFLICT (session_id, turn_id) DO NOTHING
  RETURNING turn_id
`;

export const hasChatTurnCancellationWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  turnId: string,
): Promise<boolean> => {
  const result = await queryFn(HAS_CHAT_TURN_CANCELLATION_SQL, [
    sessionId,
    turnId,
  ]);
  return result.rows.length > 0;
};

export const insertChatTurnCancellationWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  turnId: string,
): Promise<boolean> => {
  const result = await queryFn(INSERT_CHAT_TURN_CANCELLATION_SQL, [
    sessionId,
    turnId,
  ]);
  return result.rows.length > 0;
};

export const lockUncancelledChatTurnForMutationWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  turnId: string,
): Promise<void> => {
  await lockActiveChatSessionRunWithQuery(
    queryFn,
    sessionId,
    turnId,
    "execute mutating chat SQL",
  );
  if (await hasChatTurnCancellationWithQuery(queryFn, sessionId, turnId)) {
    throw new ChatTurnCancelledError(sessionId, turnId);
  }
};
