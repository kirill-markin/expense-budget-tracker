import { ApiRouteError } from "@/server/api/errors";
import {
  CHAT_RUN_STALE_HEARTBEAT_MS,
  hasActiveChatRun,
} from "@/server/chat/runtime/runtime";
import {
  ChatSessionConflictError,
  ChatSessionNotFoundError,
  getChatSessionSnapshot,
  recoverStaleChatSession,
  type ChatSessionSnapshot,
} from "@/server/chat/store";

export type SessionRecoveryDependencies = Readonly<{
  getChatSessionSnapshot: typeof getChatSessionSnapshot;
  hasActiveChatRun: typeof hasActiveChatRun;
  recoverStaleChatSession: typeof recoverStaleChatSession;
  now: () => number;
}>;

export const CHAT_STREAM_INTERRUPTED_ERROR = "This response stopped because the chat server restarted before it finished. Please send a new message to continue.";

const DEFAULT_SESSION_RECOVERY_DEPENDENCIES: SessionRecoveryDependencies = {
  getChatSessionSnapshot,
  hasActiveChatRun,
  recoverStaleChatSession,
  now: (): number => Date.now(),
};

const requireSnapshotActiveRunId = (snapshot: ChatSessionSnapshot): string => {
  if (snapshot.activeRunId === null) {
    throw new Error(`Chat stale run recovery failed: running session has no activeRunId, sessionId=${snapshot.sessionId}`);
  }

  return snapshot.activeRunId;
};

export const mapStoreErrorToRouteError = (error: unknown): never => {
  if (error instanceof ChatSessionNotFoundError) {
    throw new ApiRouteError(404, error.message);
  }

  if (error instanceof ChatSessionConflictError) {
    throw new ApiRouteError(409, "Chat session already has an active response");
  }

  throw error;
};

export const resolveSnapshotWithRunRecoveryWithDeps = async (
  userId: string,
  workspaceId: string,
  sessionId: string | undefined,
  dependencies: SessionRecoveryDependencies,
): Promise<ChatSessionSnapshot> => {
  let snapshot = await dependencies.getChatSessionSnapshot(userId, workspaceId, sessionId);

  if (snapshot.runState !== "running") {
    return snapshot;
  }

  const heartbeatAgeMs = snapshot.activeRunHeartbeatAt === null
    ? Number.POSITIVE_INFINITY
    : dependencies.now() - snapshot.activeRunHeartbeatAt;

  if (heartbeatAgeMs <= CHAT_RUN_STALE_HEARTBEAT_MS) {
    return snapshot;
  }

  const expectedActiveRunId = requireSnapshotActiveRunId(snapshot);
  if (dependencies.hasActiveChatRun(snapshot.sessionId, expectedActiveRunId)) {
    return snapshot;
  }

  await dependencies.recoverStaleChatSession(
    userId,
    workspaceId,
    {
      sessionId: snapshot.sessionId,
      expectedActiveRunId,
      errorMessage: CHAT_STREAM_INTERRUPTED_ERROR,
    },
  );

  snapshot = await dependencies.getChatSessionSnapshot(userId, workspaceId, snapshot.sessionId);
  return snapshot;
};

export const resolveSnapshotWithRunRecovery = async (
  userId: string,
  workspaceId: string,
  sessionId?: string,
): Promise<ChatSessionSnapshot> =>
  resolveSnapshotWithRunRecoveryWithDeps(
    userId,
    workspaceId,
    sessionId,
    DEFAULT_SESSION_RECOVERY_DEPENDENCIES,
  );
