import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  ChatSessionNotFoundError,
  parseMainContentInvalidationVersion,
  type ChatSessionRunState,
  type ChatSessionSnapshot,
} from "./shared";

export type ChatSessionRow = Readonly<{
  session_id: string;
  status: ChatSessionRunState;
  active_run_heartbeat_at: string | null;
  main_content_invalidation_version: string;
  updated_at: string;
}>;

const SELECT_SESSION_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND session_id = $3
`;

const SELECT_SESSION_FOR_UPDATE_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE session_id = $1
  FOR UPDATE
`;

const SELECT_LATEST_SESSION_SQL = `
  SELECT session_id, status, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
  ORDER BY created_at DESC, session_id DESC
  LIMIT 1
`;

const INSERT_SESSION_SQL = `
  INSERT INTO public.chat_sessions (
    user_id,
    workspace_id,
    status,
    active_run_heartbeat_at,
    main_content_invalidation_version,
    updated_at
  )
  VALUES ($1, $2, 'idle', NULL, 0, now())
  RETURNING session_id, status, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

const UPDATE_CHAT_SESSION_STATUS_SQL = `
  UPDATE public.chat_sessions
  SET status = $2,
      active_run_heartbeat_at = $3,
      updated_at = now()
  WHERE session_id = $1
  RETURNING session_id, status, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

export const mapSessionRow = (row: ChatSessionRow): ChatSessionSnapshot => ({
  sessionId: row.session_id,
  runState: row.status,
  updatedAt: new Date(row.updated_at).getTime(),
  activeRunHeartbeatAt: row.active_run_heartbeat_at === null
    ? null
    : new Date(row.active_run_heartbeat_at).getTime(),
  mainContentInvalidationVersion: parseMainContentInvalidationVersion(
    row.main_content_invalidation_version,
    "read",
  ),
  messages: [],
});

export const requireSessionRow = (
  row: ChatSessionRow | undefined,
  operation: string,
): ChatSessionRow => {
  if (row === undefined) {
    throw new Error(`Chat session ${operation} failed: query returned no row`);
  }

  return row;
};

const selectLatestChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow | null> => {
  const result = await queryFn(SELECT_LATEST_SESSION_SQL, [userId, workspaceId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row ?? null;
};

export const createChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(INSERT_SESSION_SQL, [userId, workspaceId]);
  return requireSessionRow(result.rows[0] as ChatSessionRow | undefined, "insert");
};

export const resolveRequestedChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(SELECT_SESSION_SQL, [userId, workspaceId, sessionId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  if (row === undefined) {
    throw new ChatSessionNotFoundError(sessionId);
  }

  return row;
};

export const resolveLatestOrCreateChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
): Promise<ChatSessionRow> => {
  const latestSession = await selectLatestChatSessionWithQuery(queryFn, userId, workspaceId);
  if (latestSession !== null) {
    return latestSession;
  }

  return createChatSessionWithQuery(queryFn, userId, workspaceId);
};

export const lockChatSessionWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(SELECT_SESSION_FOR_UPDATE_SQL, [sessionId]);
  return requireSessionRow(result.rows[0] as ChatSessionRow | undefined, "lock");
};

export const updateChatSessionStatusWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  status: ChatSessionRunState,
  heartbeatAt: Date | null,
): Promise<void> => {
  await queryFn(UPDATE_CHAT_SESSION_STATUS_SQL, [
    sessionId,
    status,
    heartbeatAt === null ? null : heartbeatAt.toISOString(),
  ]);
};

export const getChatSessionId = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<string | null> => {
  const result = await queryAs(userId, workspaceId, SELECT_SESSION_SQL, [userId, workspaceId, sessionId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row?.session_id ?? null;
};

export const getLatestChatSessionId = async (
  userId: string,
  workspaceId: string,
): Promise<string | null> => {
  const result = await queryAs(userId, workspaceId, SELECT_LATEST_SESSION_SQL, [userId, workspaceId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  return row?.session_id ?? null;
};

export const createFreshChatSession = async (
  userId: string,
  workspaceId: string,
): Promise<string> =>
  withUserContext(userId, workspaceId, async (queryFn) => {
    const row = await createChatSessionWithQuery(queryFn, userId, workspaceId);
    return row.session_id;
  });

export const touchChatSessionHeartbeat = async (
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<void> => {
  await queryAs(userId, workspaceId, UPDATE_CHAT_SESSION_STATUS_SQL, [
    sessionId,
    "running",
    new Date().toISOString(),
  ]);
};
