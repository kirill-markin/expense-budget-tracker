import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  ChatSessionRunTransitionError,
  ChatSessionNotFoundError,
  parseMainContentInvalidationVersion,
  type ChatSessionRunState,
  type ChatSessionTerminalState,
  type ChatSessionSnapshot,
} from "./shared";

export type ChatSessionRow = Readonly<{
  session_id: string;
  status: ChatSessionRunState;
  active_run_id: string | null;
  active_run_heartbeat_at: string | null;
  main_content_invalidation_version: string;
  updated_at: string;
}>;

const SELECT_SESSION_SQL = `
  SELECT session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND session_id = $3
`;

const SELECT_SESSION_FOR_UPDATE_SQL = `
  SELECT session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE session_id = $1
  FOR UPDATE
`;

const SELECT_REQUESTED_SESSION_FOR_UPDATE_SQL = `
  SELECT session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE user_id = $1
    AND workspace_id = $2
    AND session_id = $3
  FOR UPDATE
`;

const SELECT_ACTIVE_SESSION_RUN_FOR_UPDATE_SQL = `
  SELECT session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
  FROM public.chat_sessions
  WHERE session_id = $1
    AND active_run_id = $2
    AND status = 'running'
  FOR UPDATE
`;

const SELECT_LATEST_SESSION_SQL = `
  SELECT session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
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
    active_run_id,
    active_run_heartbeat_at,
    main_content_invalidation_version,
    updated_at
  )
  VALUES ($1, $2, 'idle', NULL, NULL, 0, now())
  RETURNING session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

const START_CHAT_SESSION_RUN_SQL = `
  UPDATE public.chat_sessions
  SET status = 'running',
      active_run_id = $2,
      active_run_heartbeat_at = $3,
      updated_at = now()
  WHERE session_id = $1
    AND status <> 'running'
  RETURNING session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

const COMPLETE_CHAT_SESSION_RUN_SQL = `
  UPDATE public.chat_sessions
  SET status = $3,
      active_run_id = NULL,
      active_run_heartbeat_at = NULL,
      updated_at = now()
  WHERE session_id = $1
    AND active_run_id = $2
    AND status = 'running'
  RETURNING session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

const TOUCH_CHAT_SESSION_HEARTBEAT_SQL = `
  UPDATE public.chat_sessions
  SET active_run_heartbeat_at = $3,
      updated_at = now()
  WHERE session_id = $1
    AND active_run_id = $2
    AND status = 'running'
  RETURNING session_id, status, active_run_id, active_run_heartbeat_at, main_content_invalidation_version, updated_at
`;

export const mapSessionRow = (row: ChatSessionRow): ChatSessionSnapshot => ({
  sessionId: row.session_id,
  runState: row.status,
  updatedAt: new Date(row.updated_at).getTime(),
  activeRunId: row.active_run_id,
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

export const requireActiveRunId = (
  row: ChatSessionRow,
  operation: string,
): string => {
  if (row.active_run_id === null) {
    throw new Error(`Chat session ${operation} failed: running session has no active_run_id, sessionId=${row.session_id}`);
  }

  return row.active_run_id;
};

const requireSessionRunTransitionRow = (
  row: ChatSessionRow | undefined,
  sessionId: string,
  activeRunId: string,
  targetState: ChatSessionTerminalState,
): ChatSessionRow => {
  if (row === undefined) {
    throw new ChatSessionRunTransitionError({
      sessionId,
      activeRunId,
      operation: "final state transition",
      targetState,
    });
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

export const lockRequestedChatSessionWithQuery = async (
  queryFn: QueryFn,
  userId: string,
  workspaceId: string,
  sessionId: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(SELECT_REQUESTED_SESSION_FOR_UPDATE_SQL, [userId, workspaceId, sessionId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  if (row === undefined) {
    throw new ChatSessionNotFoundError(sessionId);
  }

  return row;
};

export const lockActiveChatSessionRunWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  activeRunId: string,
  operation: string,
): Promise<ChatSessionRow> => {
  const result = await queryFn(SELECT_ACTIVE_SESSION_RUN_FOR_UPDATE_SQL, [sessionId, activeRunId]);
  const row = result.rows[0] as ChatSessionRow | undefined;
  if (row === undefined) {
    throw new ChatSessionRunTransitionError({
      sessionId,
      activeRunId,
      operation,
    });
  }

  return row;
};

export const startChatSessionRunWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  activeRunId: string,
  heartbeatAt: Date | null,
): Promise<void> => {
  const result = await queryFn(START_CHAT_SESSION_RUN_SQL, [
    sessionId,
    activeRunId,
    heartbeatAt === null ? null : heartbeatAt.toISOString(),
  ]);
  requireSessionRow(result.rows[0] as ChatSessionRow | undefined, "start run");
};

export const completeChatSessionRunWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  activeRunId: string,
  targetState: ChatSessionTerminalState,
): Promise<void> => {
  const result = await queryFn(COMPLETE_CHAT_SESSION_RUN_SQL, [
    sessionId,
    activeRunId,
    targetState,
  ]);
  requireSessionRunTransitionRow(
    result.rows[0] as ChatSessionRow | undefined,
    sessionId,
    activeRunId,
    targetState,
  );
};

export const touchChatSessionHeartbeatWithQuery = async (
  queryFn: QueryFn,
  sessionId: string,
  activeRunId: string,
  heartbeatAt: Date,
): Promise<boolean> => {
  const result = await queryFn(TOUCH_CHAT_SESSION_HEARTBEAT_SQL, [
    sessionId,
    activeRunId,
    heartbeatAt.toISOString(),
  ]);
  return result.rows.length > 0;
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
  activeRunId: string,
): Promise<void> => {
  await queryAs(userId, workspaceId, TOUCH_CHAT_SESSION_HEARTBEAT_SQL, [
    sessionId,
    activeRunId,
    new Date().toISOString(),
  ]);
};
